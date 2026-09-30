// Rules for a fuel's tariff history: each tariff covers [from, to) and no two
// may overlap. `to === null` means "still on it" (only the latest may be open).
// Pure functions — they take and return plain arrays so they can be unit tested.

/** Placeholder start for a first tariff whose real start date isn't known. */
export const SINCE_START = '2000-01-01T00:00:00.000Z';

const t0 = (iso) => Date.parse(iso);
const end = (t) => (t.to ? Date.parse(t.to) : Infinity);
const overlaps = (a, b) => t0(a.from) < end(b) && t0(b.from) < end(a);

/**
 * Add a tariff to one fuel's list.
 * - An open-ended tariff (no end date) replaces the current one from its
 *   start date: the current tariff is closed the day it starts.
 * - A first tariff with an unknown start ("from the start") is trimmed to
 *   begin where a new earlier tariff ends.
 * - Anything else that overlaps is refused, naming the clash.
 * @returns {{ok:true, list:object[], notes:string[]} | {ok:false, error:string}}
 */
export function planAdd(list, t, describe = (x) => x.label || 'another tariff') {
  if (t.to && t0(t.to) <= t0(t.from)) return { ok: false, error: 'The end date must be after the start date.' };
  const next = list.map((x) => ({ ...x }));
  const notes = [];

  if (!t.to) {
    const open = next.find((x) => !x.to);
    if (open) {
      if (t0(open.from) >= t0(t.from)) {
        return {
          ok: false,
          error: `This starts on or before ${describe(open)}, which you’re still on. Give this one an end date, or change that tariff’s dates first.`,
        };
      }
      open.to = t.from;
      notes.push(`${describe(open)} now ends when this one starts.`);
    }
  }

  for (const o of next) {
    if (!overlaps(o, t)) continue;
    const trimmable = o.from === SINCE_START && t.to && t0(t.from) > t0(o.from) && t0(t.to) < end(o);
    if (trimmable) {
      o.from = t.to;
      notes.push(`${describe(o)} now starts when this one ends.`);
      continue;
    }
    return { ok: false, error: `Those dates overlap ${describe(o)}. Change that tariff’s dates first.` };
  }

  // Trimming may have put a started-before placeholder after this tariff; recheck.
  const check = validate([...next, t]);
  if (check) return { ok: false, error: check };
  return { ok: true, list: [...next, t], notes };
}

/** Change a tariff's dates, refusing overlaps and a second open tariff. */
export function planEdit(list, id, from, to, describe = (x) => x.label || 'another tariff') {
  if (to && t0(to) <= t0(from)) return { ok: false, error: 'The end date must be after the start date.' };
  const next = list.map((x) => (x.id === id ? { ...x, from, to: to || null } : { ...x }));
  const me = next.find((x) => x.id === id);
  for (const o of next) {
    if (o === me) continue;
    if (!to && !o.to) return { ok: false, error: `Only one tariff can have no end date. End ${describe(o)} first.` };
    if (overlaps(o, me)) return { ok: false, error: `Those dates overlap ${describe(o)}.` };
  }
  if (!to && next.some((o) => o !== me && t0(o.from) > t0(from))) {
    return { ok: false, error: 'A tariff that started later exists, so this one needs an end date.' };
  }
  return { ok: true, list: next };
}

/** First problem found in a list, or null. */
export function validate(list) {
  const sorted = [...list].sort((a, b) => t0(a.from) - t0(b.from));
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.to && t0(a.to) <= t0(a.from)) return 'A tariff ends before it starts.';
    if (!a.to && i + 1 < sorted.length) return 'Only the latest tariff can have no end date.';
    if (i + 1 < sorted.length && overlaps(a, sorted[i + 1])) return 'Two tariffs overlap.';
  }
  return null;
}
