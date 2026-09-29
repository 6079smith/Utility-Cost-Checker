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
    throw new Error('The photo couldn’t be read. Please enter the reading manually.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('No reading returned. Please enter it manually.');
  return JSON.parse(text);
}
