// Shared by the app (own-key mode) and the helper Worker so both read meters
// the same way.

export const METER_MODEL = 'claude-opus-5-5';

export const METER_SYSTEM = `You read UK domestic gas and electricity meters from photos.

Report each register the way a UK supplier would record it:
- Read only the whole-unit digits. Ignore digits in red, digits after a decimal point, and any digit shown in a differently coloured or separately boxed final position; those are fractions.
- Keep leading zeros in "digits" but give "value" as a number.
- Gas meters read in cubic metres (m³) or, on older imperial meters, in hundreds of cubic feet (ft³). Gas meters have one register.
- Economy 7 electricity meters have two registers. On dial or mechanical meters both rows are visible, often labelled "Low"/"Normal", "Night"/"Day" or "Rate 1"/"Rate 2". Digital meters show one register per screen, with a label such as "Rate 1", "R01", "IMP R2", "1.8.1" or "1.8.2". Report every register you can see, one entry each.
- In "label", copy the register's label exactly as printed or displayed ("Low", "Rate 2", "1.8.1", …). If a register has no label, describe its position ("top row", "bottom row"). For a single-register meter use "single".
- Skip total/sum registers (e.g. "1.8.0", "Total") when separate rate registers are shown, and skip export, reactive (kvarh), demand, clock and date screens.
- If the display is unreadable, obscured or is not a meter, return no registers and explain in "notes".
- Use "confidence" honestly: "low" if any digit is a guess.`;

export const METER_SCHEMA = {
  type: 'object',
  properties: {
    registers: {
      type: 'array',
      description: 'One entry per readable consumption register; empty if unreadable',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Label as shown, e.g. "Low", "Normal", "Rate 1", "1.8.2", or "single"' },
          digits: { type: 'string', description: 'Whole-unit digits exactly as shown, including leading zeros' },
          value: { type: 'number' },
        },
        required: ['label', 'digits', 'value'],
        additionalProperties: false,
      },
    },
    meter_kind: { type: 'string', enum: ['electricity', 'gas', 'unknown'] },
    unit: { type: 'string', enum: ['kWh', 'm3', 'ft3', 'unknown'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string', description: 'Short note for the user; empty if nothing to add' },
  },
  required: ['registers', 'meter_kind', 'unit', 'confidence', 'notes'],
  additionalProperties: false,
};

export function meterUserText({ fuel, economy7, previous }) {
  let t = `This should be a ${fuel} meter`;
  if (economy7) t += ' with two registers (Economy 7), though a digital display may show only one of them in this photo';
  t += '.';
  if (previous) t += ` The previous reading was ${previous}; new values are normally the same or higher.`;
  return t + ' Read the meter.';
}

/** Build Messages API params. Used identically by browser and Worker. */
export function meterRequest({ imageBase64, mediaType, fuel, economy7 = false, previous }) {
  return {
    model: METER_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: METER_SCHEMA } },
    system: METER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: meterUserText({ fuel, economy7, previous }) },
        ],
      },
    ],
  };
}

/** Pull the structured result out of a Messages API response. */
export function parseMeterResponse(response) {
  if (response.stop_reason === 'refusal') {
    throw new Error('The photo couldn’t be read. Please enter it manually.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Nothing was read. Please enter it manually.');
  return JSON.parse(text);
}

/**
 * Send the meter request. The refusal fallback is an optional beta; if the
 * account rejects it, retry once as a plain request.
 */
export async function createMeterMessage(client, params) {
  try {
    return await client.beta.messages.create(params);
  } catch (err) {
    if (err?.status === 400 && /fallback|beta/i.test(apiErrorText(err))) {
      const { betas, fallbacks, ...plain } = params;
      return client.messages.create(plain);
    }
    throw err;
  }
}

/** Anthropic's own error text from an SDK error, e.g. "Your credit balance is too low…". */
export function apiErrorText(err) {
  return err?.error?.error?.message || err?.message || String(err);
}

/** A message the person holding the phone can act on. */
export function friendlyApiError(err) {
  const text = apiErrorText(err);
  if (/credit balance/i.test(text)) {
    return 'Your Anthropic API account has no credit. Top up at console.anthropic.com → Billing. (A Claude.ai subscription doesn’t include API credit.)';
  }
  if (err?.status === 401) return 'The Claude API key is invalid.';
  if (err?.status === 403) return `The Claude API key isn’t allowed to do this: ${text}`;
  if (err?.status === 404 || /model/i.test(text)) return `Claude model not available on this account: ${text}`;
  if (err?.status === 429) return 'Busy right now. Try again in a minute.';
  return `Claude API error ${err?.status ?? ''}: ${text}`;
}

// ---------- Reading prices from a bill ----------

export const BILL_SYSTEM = `You read UK domestic energy bills and annual statements and pull out the tariff prices.

- Report prices in pence: unit rates in p/kWh and standing charges in p/day. Convert £ to pence (e.g. £0.2450/kWh → 24.5).
- Economy 7 / two-rate electricity: put the day (peak/normal) rate in unit_rate_p and the night (off-peak/low) rate in night_rate_p. Otherwise night_rate_p is null.
- If a fuel isn't on the bill, set found to false and its prices to null.
- If prices changed during the bill period, report the most recent prices and say so in "notes".
- prices_include_vat: true if the rates as printed already include VAT, false if VAT (5%) is added separately.
- Dates as YYYY-MM-DD. tariff_start / tariff_end are the contract or tariff dates (e.g. "Fixed until", "Tariff end date"); null if not shown. bill_period_start / bill_period_end are the dates the bill covers.
- supplier is the company (e.g. "British Gas"); tariff_name is the tariff as printed (e.g. "Fixed Price Nov 2026").
- Gas calorific value (calorific_value): in MJ/m³, usually 37–42. If the bill shows several, report the average for the bill period. If none is shown, report null. Don't confuse it with the volume correction (1.02264) or with kWh figures.
- If the image is not an energy bill or is unreadable, set found to false for both fuels and explain in "notes".`;

const price = { type: ['number', 'null'] };
const isoDate = { type: ['string', 'null'], description: 'YYYY-MM-DD or null' };

export const BILL_SCHEMA = {
  type: 'object',
  properties: {
    supplier: { type: 'string' },
    tariff_name: { type: 'string' },
    electricity: {
      type: 'object',
      properties: { found: { type: 'boolean' }, unit_rate_p: price, night_rate_p: price, standing_charge_p: price },
      required: ['found', 'unit_rate_p', 'night_rate_p', 'standing_charge_p'],
      additionalProperties: false,
    },
    gas: {
      type: 'object',
      properties: { found: { type: 'boolean' }, unit_rate_p: price, standing_charge_p: price, calorific_value: { type: ['number', 'null'] } },
      required: ['found', 'unit_rate_p', 'standing_charge_p', 'calorific_value'],
      additionalProperties: false,
    },
    prices_include_vat: { type: 'boolean' },
    tariff_start: isoDate,
    tariff_end: isoDate,
    bill_period_start: isoDate,
    bill_period_end: isoDate,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: [
    'supplier',
    'tariff_name',
    'electricity',
    'gas',
    'prices_include_vat',
    'tariff_start',
    'tariff_end',
    'bill_period_start',
    'bill_period_end',
    'confidence',
    'notes',
  ],
  additionalProperties: false,
};

export const BILL_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** Messages API params for a bill photo or PDF. */
export function billRequest({ fileBase64, mediaType }) {
  const source = { type: 'base64', media_type: mediaType, data: fileBase64 };
  const file = mediaType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
  return {
    model: METER_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: BILL_SCHEMA } },
    system: BILL_SYSTEM,
    messages: [{ role: 'user', content: [file, { type: 'text', text: 'Read the tariff prices from this bill.' }] }],
  };
}
