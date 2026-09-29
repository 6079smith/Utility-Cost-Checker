// Map the register labels a meter shows onto Economy 7 day/night.
//
// Labels vary: dial meters say "Low"/"Normal", digital meters "Rate 1"/"R02"/
// "1.8.1". Which of Rate 1 / Rate 2 is the night rate is not standard across
// meters, so that comes from a user setting (`rate1Is`).

/** @returns {'day'|'night'|'rate1'|'rate2'|'total'|'unknown'} */
export function classifyLabel(label) {
  const raw = String(label || '').toLowerCase();
  if (/1\.8\.0|total|\bsum\b/.test(raw)) return 'total';
  if (/1\.8\.1/.test(raw)) return 'rate1';
  if (/1\.8\.2/.test(raw)) return 'rate2';
  // Check night words first: "off-peak" contains "peak".
  if (/night|\blow\b|off[\s-]?peak|economy/.test(raw)) return 'night';
  if (/\bday\b|normal|\bpeak\b|standard|\bhigh\b/.test(raw)) return 'day';
  const compact = raw.replace(/[^a-z0-9]/g, '');
  const m = compact.match(/(?:rate|reg|register|tariff|imp|r|t)0*([12])$/);
  if (m) return m[1] === '1' ? 'rate1' : 'rate2';
  return 'unknown';
}

/**
 * @param {{label:string,value:number}[]} registers  from the meter reader
 * @param {'night'|'day'} rate1Is
 * @returns {{day:number|null, night:number|null, ambiguous:boolean}}
 */
export function mapRegisters(registers, rate1Is = 'night') {
  const rate2Is = rate1Is === 'night' ? 'day' : 'night';
  const rows = registers
    .map((r) => {
      const kind = classifyLabel(r.label);
      const slot = kind === 'rate1' ? rate1Is : kind === 'rate2' ? rate2Is : kind;
      return { ...r, kind, slot };
    })
    .filter((r) => r.slot !== 'total' || registers.length === 1);

  const out = { day: null, night: null, ambiguous: false };
  const unknown = [];
  for (const r of rows) {
    if ((r.slot === 'day' || r.slot === 'night') && out[r.slot] === null) out[r.slot] = r.value;
    else unknown.push(r);
  }
  for (const r of unknown) {
    // Fill whichever slot is still empty, in order; the user must confirm.
    const slot = out.day === null ? 'day' : out.night === null ? 'night' : null;
    if (!slot) break;
    out[slot] = r.value;
    out.ambiguous = true;
  }
  return out;
}

/** True if swapping day/night makes both registers go forwards when as-read they don't. */
export function looksSwapped(day, night, prev) {
  if (!prev || typeof prev.night !== 'number' || day == null || night == null) return false;
  const asRead = day >= prev.value && night >= prev.night;
  const swapped = night >= prev.value && day >= prev.night;
  return !asRead && swapped;
}
