// Octopus Energy public tariff API (no account or key needed).
// https://developer.octopus.energy/rest/
//
// Requests go straight to api.octopus.energy. If the browser blocks that
// (network/CORS), they are retried through the optional helper Worker, which
// forwards read-only /v1/ requests.

const API = 'https://api.octopus.energy';

export const REGIONS = {
  A: 'Eastern England',
  B: 'East Midlands',
  C: 'London',
  D: 'Merseyside & North Wales',
  E: 'West Midlands',
  F: 'North East England',
  G: 'North West England',
  H: 'Southern England',
  J: 'South East England',
  K: 'South Wales',
  L: 'South West England',
  M: 'Yorkshire',
  N: 'South Scotland',
  P: 'North Scotland',
};

async function getJson(pathAndQuery, proxyUrl) {
  try {
    const res = await fetch(API + pathAndQuery);
    if (!res.ok) throw new HttpError(res.status);
    return await res.json();
  } catch (err) {
    if (err instanceof HttpError || !proxyUrl) throw friendly(err);
    const res = await fetch(proxyUrl.replace(/\/$/, '') + '/octopus' + pathAndQuery);
    if (!res.ok) throw friendly(new HttpError(res.status));
    return res.json();
  }
}

class HttpError extends Error {
  constructor(status) {
    super(`Octopus API returned ${status}`);
    this.status = status;
  }
}

function friendly(err) {
  if (err instanceof HttpError && err.status === 404) {
    return new Error('Octopus doesn’t offer that tariff for your region and meter type. Check the product code and meter type.');
  }
  if (err instanceof HttpError) return err;
  return new Error('Couldn’t reach Octopus. Check your connection and try again.');
}

async function getAllPages(pathAndQuery, proxyUrl, maxPages = 10) {
  const out = [];
  let next = pathAndQuery;
  for (let i = 0; next && i < maxPages; i++) {
    const page = await getJson(next, proxyUrl);
    out.push(...page.results);
    next = page.next ? page.next.replace(API, '') : null;
  }
  return out;
}

/** Postcode → region letter (A–P), e.g. "SW1A 1AA" → "C". */
export async function regionForPostcode(postcode, proxyUrl) {
  const pc = postcode.replace(/\s+/g, '').toUpperCase();
  const data = await getJson(`/v1/industry/grid-supply-points/?postcode=${encodeURIComponent(pc)}`, proxyUrl);
  const group = data.results?.[0]?.group_id;
  if (!group) throw new Error('Postcode not recognised.');
  return group.replace('_', '');
}

/** Current domestic import products (e.g. Flexible Octopus, Tracker, Fixed). */
export async function listProducts(proxyUrl) {
  const products = await getAllPages('/v1/products/?brand=OCTOPUS_ENERGY&is_business=false&page_size=100', proxyUrl);
  return products
    .filter((p) => p.direction === 'IMPORT' && !p.is_prepay)
    .map((p) => ({ code: p.code, name: p.display_name || p.full_name, tracker: !!p.is_tracker, variable: !!p.is_variable }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** e.g. E-1R-VAR-22-11-01-C (single rate) or E-2R-VAR-22-11-01-C (Economy 7). */
export function tariffCode(fuel, productCode, region, registers = 1) {
  if (fuel === 'gas') return `G-1R-${productCode}-${region}`;
  return `E-${registers === 2 ? '2R' : '1R'}-${productCode}-${region}`;
}

function toSeries(results, paymentMethod) {
  // Some products publish separate Direct Debit / non-DD prices.
  const hasMethods = results.some((r) => r.payment_method);
  return results
    .filter((r) => !hasMethods || !r.payment_method || r.payment_method === paymentMethod)
    .map((r) => ({ from: r.valid_from, to: r.valid_to, value: r.value_exc_vat }))
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
}

/**
 * Fetch unit rates (p/kWh) and standing charges (p/day), exc. VAT, from
 * `sinceIso` onwards. Returned as {from, to, value} series ready for calc.js.
 * With registers = 2 (Economy 7) `unit` is the day rate and `night` the night rate.
 */
export async function fetchRates({ fuel, productCode, region, registers = 1, sinceIso, paymentMethod = 'DIRECT_DEBIT', proxyUrl }) {
  const e7 = fuel === 'electricity' && registers === 2;
  const code = tariffCode(fuel, productCode, region, e7 ? 2 : 1);
  const base = `/v1/products/${encodeURIComponent(productCode)}/${fuel}-tariffs/${code}`;
  const q = `?period_from=${encodeURIComponent(sinceIso)}&page_size=1500`;
  const [unit, night, standing] = await Promise.all([
    getAllPages(`${base}/${e7 ? 'day-unit-rates' : 'standard-unit-rates'}/${q}`, proxyUrl),
    e7 ? getAllPages(`${base}/night-unit-rates/${q}`, proxyUrl) : Promise.resolve(null),
    getAllPages(`${base}/standing-charges/${q}`, proxyUrl),
  ]);
  if (!unit.length || (e7 && !night.length)) {
    throw new Error(`No ${e7 ? 'Economy 7 ' : ''}${fuel} prices published for ${code}.`);
  }
  return {
    tariffCode: code,
    unit: toSeries(unit, paymentMethod),
    night: e7 ? toSeries(night, paymentMethod) : null,
    standing: toSeries(standing, paymentMethod),
  };
}
