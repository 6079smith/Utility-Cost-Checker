// Shared by the app (own-key mode) and the helper Worker so both read meters
// the same way.

export const METER_MODEL = 'claude-opus-5-5';

export const METER_SYSTEM = `You read UK domestic gas and electricity meters from photos.

Report the billing register the way a UK supplier would record it:
- Read only the whole-unit digits. Ignore digits in red, digits after a decimal point, and any digit shown in a differently coloured or separately boxed final position; those are fractions.
- Keep leading zeros in "digits" but give "value" as a number.
- Digital electricity meters may cycle through screens; use the one showing total import kWh. If two registers are visible (Economy 7 day/night), say so in "notes" and report the one labelled total or day.
- Gas meters read in cubic metres (m³) or, on older imperial meters, in hundreds of cubic feet (ft³).
- If the display is unreadable, obscured or is not a meter, set value to null and explain in "notes".
- Use "confidence" honestly: "low" if any digit is a guess.`;

export const METER_SCHEMA = {
  type: 'object',
  properties: {
    digits: { type: 'string', description: 'Whole-unit digits exactly as shown, including leading zeros' },
    value: { type: ['number', 'null'], description: 'Numeric reading, or null if unreadable' },
    meter_kind: { type: 'string', enum: ['electricity', 'gas', 'unknown'] },
    unit: { type: 'string', enum: ['kWh', 'm3', 'ft3', 'unknown'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string', description: 'Short note for the user; empty if nothing to add' },
  },
  required: ['digits', 'value', 'meter_kind', 'unit', 'confidence', 'notes'],
  additionalProperties: false,
};

export function meterUserText({ fuel, previous }) {
  let t = `This should be a ${fuel} meter.`;
  if (previous != null) t += ` The previous reading was ${previous}; the new reading is normally the same or higher.`;
  return t + ' Read the meter.';
}

/** Build Messages API params. Used identically by browser and Worker. */
export function meterRequest({ imageBase64, mediaType, fuel, previous }) {
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
          { type: 'text', text: meterUserText({ fuel, previous }) },
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
