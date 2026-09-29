// All data lives on this device in localStorage. Nothing is sent anywhere
// except meter photos (to the AI reader) and tariff lookups (to Octopus).

const KEY = 'ucc:v1';

export const FUELS = ['electricity', 'gas'];

const defaults = () => ({
  version: 1,
  settings: {
    postcode: '',
    region: '',
    vatRate: 0.05,
    paymentMethod: 'DIRECT_DEBIT',
    // 'dark' (default), 'light' or 'system' (follow the iPhone setting).
    theme: 'dark',
    gas: { units: 'm3', calorificValue: 39.5 },
    // meter: 'single' or 'e7' (Economy 7: day + night registers).
    electricity: { meter: 'single', rate1Is: 'night' },
    ai: { mode: 'helper', helperUrl: '', accessCode: '', apiKey: '' },
  },
  tariffs: [],
  readings: [],
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    const d = defaults();
    return {
      ...d,
      ...parsed,
      settings: {
        ...d.settings,
        ...parsed.settings,
        gas: { ...d.settings.gas, ...parsed.settings?.gas },
        electricity: { ...d.settings.electricity, ...parsed.settings?.electricity },
        ai: { ...d.settings.ai, ...parsed.settings?.ai },
      },
    };
  } catch {
    return defaults();
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    alert('Couldn’t save on this device: ' + err.message);
  }
  listeners.forEach((fn) => fn(state));
}

export const getState = () => state;
export const subscribe = (fn) => listeners.add(fn);

export function update(mutator) {
  mutator(state);
  save();
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function readingsFor(fuel) {
  return state.readings.filter((r) => r.fuel === fuel).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function lastReading(fuel, before = Infinity) {
  const list = readingsFor(fuel).filter((r) => Date.parse(r.at) < before);
  return list[list.length - 1] || null;
}

export function tariffsFor(fuel) {
  return state.tariffs.filter((t) => t.fuel === fuel).sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
}

export const isEconomy7 = () => state.settings.electricity.meter === 'e7';

export function currentTariff(fuel) {
  return tariffsFor(fuel).find((t) => !t.to) || null;
}

/**
 * Start a new tariff from `fromIso`, closing whichever tariff was current.
 * Past readings keep being costed at the old tariff’s prices.
 */
export function switchTariff(tariff) {
  update((s) => {
    const cur = s.tariffs.find((t) => t.fuel === tariff.fuel && !t.to);
    if (cur) {
      if (Date.parse(tariff.from) <= Date.parse(cur.from)) {
        // Same or earlier start: replace instead of creating a zero-length tariff.
        s.tariffs = s.tariffs.filter((t) => t !== cur);
      } else {
        cur.to = tariff.from;
      }
    }
    s.tariffs.push({ id: uid(), to: null, ...tariff });
  });
}

export function exportJson() {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.readings) || !Array.isArray(parsed.tariffs)) {
    throw new Error('That file isn’t a Utility Cost Checker backup.');
  }
  localStorage.setItem(KEY, JSON.stringify(parsed));
  state = load();
  save();
}

/** Ask the browser not to evict our data (iOS home-screen apps honour this). */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
