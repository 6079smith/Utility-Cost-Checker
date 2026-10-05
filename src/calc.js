// Pure cost/usage maths. No DOM, no storage — unit tested in tests/calc.test.js.
//
// Money is handled in pence, excluding VAT, until the final step. Tariffs are
// flattened into "segments": { from, to, unit, standing } where unit is p/kWh
// and standing is p/day (both exc. VAT) and to === null means "still current".

export const GAS_VOLUME_CORRECTION = 1.02264;
export const FT3_TO_M3 = 2.83168;
export const DEFAULT_CALORIFIC_VALUE = 39.5;
export const CV_MIN = 30;
export const CV_MAX = 50;
export const DEFAULT_VAT_RATE = 0.05;

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/**
 * Meters only count whole units, so readings close together give wildly
 * wrong rates (1 kWh in a minute looks like 60 kWh an hour). Averages and
 * projections need at least this much time between readings.
 */
export const MIN_RATE_HOURS = 6;

const ms = (t) => (t instanceof Date ? t.getTime() : new Date(t).getTime());

/** Classify a calorific value read from a bill: 'none' (null), 'ok' (30–50 MJ/m³) or 'bad'. */
export function checkCalorificValue(v) {
  if (v == null) return 'none';
  return typeof v === 'number' && Number.isFinite(v) && v >= CV_MIN && v <= CV_MAX ? 'ok' : 'bad';
}

/** Convert a meter-unit difference to kWh. Electricity meters already read kWh. */
export function toKwh(fuel, units, gas = {}) {
  if (fuel !== 'gas') return units;
  const m3 = gas.units === 'ft3' ? units * FT3_TO_M3 : units;
  const cv = gas.calorificValue || DEFAULT_CALORIFIC_VALUE;
  return (m3 * GAS_VOLUME_CORRECTION * cv) / 3.6;
}

/**
 * Turn readings for one fuel into consumption intervals between consecutive
 * readings. A reading flagged `reset` (new meter / meter replaced) starts a new
 * series and produces no interval.
 *
 * Economy 7 electricity readings carry a second register in `night`; `value`
 * is then the day (normal) register. A pair where only one reading has a night
 * register (the meter type changed) produces no interval.
 */
export function buildIntervals(readings, fuel, gas) {
  const hasNight = (r) => fuel === 'electricity' && typeof r.night === 'number';
  const sorted = readings
    .filter((r) => r.fuel === fuel)
    .sort((a, b) => ms(a.at) - ms(b.at));
  const intervals = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.reset || hasNight(prev) !== hasNight(cur)) continue;
    const from = ms(prev.at);
    const to = ms(cur.at);
    if (to <= from) continue;
    const units = cur.value - prev.value;
    const nightUnits = hasNight(cur) ? cur.night - prev.night : 0;
    const dayKwh = toKwh(fuel, units, gas);
    const nightKwh = nightUnits;
    intervals.push({
      fuel,
      from,
      to,
      units,
      nightUnits: hasNight(cur) ? nightUnits : undefined,
      dayKwh,
      nightKwh,
      kwh: dayKwh + nightKwh,
      startReadingId: prev.id,
      endReadingId: cur.id,
      invalid: units < 0 || nightUnits < 0,
    });
  }
  return intervals;
}

/**
 * Flatten stored tariffs for one fuel into chronological rate segments.
 * `night` is the Economy 7 night unit rate, or null for single-rate tariffs.
 */
export function tariffSegments(tariffs, fuel) {
  const segs = [];
  for (const t of tariffs.filter((x) => x.fuel === fuel)) {
    const tFrom = ms(t.from);
    const tTo = t.to ? ms(t.to) : null;
    if (t.supplier === 'octopus' && t.rates) {
      segs.push(...mergeRateSeries(t.rates, tFrom, tTo));
    } else {
      segs.push({ from: tFrom, to: tTo, unit: t.unitRate, night: t.nightRate ?? null, standing: t.standingCharge });
    }
  }
  return segs.sort((a, b) => a.from - b.from);
}

/**
 * Combine separately-dated rate series (Octopus style, {from, to, value}) for
 * `unit`, optional `night` and `standing` into segments where all are
 * constant, clipped to [clipFrom, clipTo).
 */
export function mergeRateSeries({ unit = [], night = null, standing = [] }, clipFrom, clipTo) {
  const all = [...unit, ...standing, ...(night || [])];
  const bounds = new Set([clipFrom]);
  if (clipTo !== null) bounds.add(clipTo);
  for (const s of all) {
    const f = ms(s.from);
    const t = s.to ? ms(s.to) : null;
    if (f > clipFrom && (clipTo === null || f < clipTo)) bounds.add(f);
    if (t !== null && t > clipFrom && (clipTo === null || t < clipTo)) bounds.add(t);
  }
  const points = [...bounds].sort((a, b) => a - b);
  const valueAt = (series, t) => {
    const hit = series.find((s) => ms(s.from) <= t && (!s.to || ms(s.to) > t));
    return hit ? hit.value : null;
  };
  const segs = [];
  for (let i = 0; i < points.length; i++) {
    const from = points[i];
    const to = i + 1 < points.length ? points[i + 1] : clipTo;
    if (to !== null && to <= from) continue;
    const u = valueAt(unit, from);
    const n = night ? valueAt(night, from) : null;
    const st = valueAt(standing, from);
    if (u === null && st === null) continue;
    const prev = segs[segs.length - 1];
    if (prev && prev.to === from && prev.unit === u && prev.night === n && prev.standing === st) {
      prev.to = to;
    } else {
      segs.push({ from, to, unit: u, night: n, standing: st });
    }
  }
  return segs;
}

function segmentAt(segments, t) {
  return segments.find((s) => s.from <= t && (s.to === null || s.to > t)) || null;
}

function nextLocalMidnight(t) {
  const d = new Date(t);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** Local calendar date key, e.g. "2026-09-29". */
export function dayKey(t) {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Cost one interval, assuming usage was spread evenly across it. The interval
 * is cut at local midnights and tariff changes so each piece has one rate and
 * belongs to one calendar day.
 *
 * Returns pence including VAT plus a per-day breakdown.
 */
export function costInterval(interval, segments, vatRate = DEFAULT_VAT_RATE) {
  const { from, to } = interval;
  const dayKwh = interval.dayKwh ?? interval.kwh;
  const nightKwh = interval.nightKwh ?? 0;
  const duration = to - from;
  const cuts = new Set([from, to]);
  for (let m = nextLocalMidnight(from); m < to; m = nextLocalMidnight(m)) cuts.add(m);
  for (const s of segments) {
    if (s.from > from && s.from < to) cuts.add(s.from);
    if (s.to !== null && s.to > from && s.to < to) cuts.add(s.to);
  }
  const points = [...cuts].sort((a, b) => a - b);

  let energyP = 0;
  let standingP = 0;
  let uncoveredMs = 0;
  let noNightRate = false;
  const days = {};
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const frac = (b - a) / duration;
    const pieceDay = dayKwh * frac;
    const pieceNight = nightKwh * frac;
    const pieceKwh = pieceDay + pieceNight;
    const seg = segmentAt(segments, a);
    let e = 0;
    let s = 0;
    if (seg) {
      // A night register on a single-rate tariff is charged at the unit rate.
      if (pieceNight > 0 && seg.night == null) noNightRate = true;
      e = pieceDay * (seg.unit ?? 0) + pieceNight * (seg.night ?? seg.unit ?? 0);
      s = ((b - a) / DAY) * (seg.standing ?? 0);
    } else {
      uncoveredMs += b - a;
    }
    energyP += e;
    standingP += s;
    const k = dayKey(a);
    const d = (days[k] ||= { kwh: 0, nightKwh: 0, costP: 0, ms: 0 });
    d.kwh += pieceKwh;
    d.nightKwh += pieceNight;
    d.costP += (e + s) * (1 + vatRate);
    d.ms += b - a;
  }
  const netP = energyP + standingP;
  return {
    energyP,
    standingP,
    vatP: netP * vatRate,
    totalP: netP * (1 + vatRate),
    days,
    missingTariff: uncoveredMs > 0,
    noNightRate,
  };
}

/** Per-hour/day/week averages for an interval and its cost. */
export function rates(interval, cost) {
  const hours = (interval.to - interval.from) / HOUR;
  const perHour = { kwh: interval.kwh / hours, costP: cost.totalP / hours };
  return {
    hours,
    days: hours / 24,
    perHour,
    perDay: { kwh: perHour.kwh * 24, costP: perHour.costP * 24 },
    perWeek: { kwh: perHour.kwh * 168, costP: perHour.costP * 168 },
  };
}

/**
 * Full analysis for one fuel: costed intervals and a merged daily series.
 * Days only partly covered by readings keep their covered fraction in `ms`.
 */
export function analyseFuel({ readings, tariffs, fuel, gas, vatRate = DEFAULT_VAT_RATE }) {
  const segments = tariffSegments(tariffs, fuel);
  const intervals = buildIntervals(readings, fuel, gas)
    .filter((iv) => !iv.invalid)
    .map((iv) => {
      const cost = costInterval(iv, segments, vatRate);
      return { ...iv, cost, rates: rates(iv, cost) };
    });
  const daily = {};
  for (const iv of intervals) {
    for (const [k, d] of Object.entries(iv.cost.days)) {
      const acc = (daily[k] ||= { kwh: 0, nightKwh: 0, costP: 0, ms: 0 });
      acc.kwh += d.kwh;
      acc.nightKwh += d.nightKwh;
      acc.costP += d.costP;
      acc.ms += d.ms;
    }
  }
  return { fuel, segments, intervals, daily };
}

/** Sum daily buckets whose date falls within [fromKey, toKey] inclusive. */
export function sumDays(daily, fromKey, toKey) {
  let kwh = 0;
  let costP = 0;
  let coveredMs = 0;
  for (const [k, d] of Object.entries(daily)) {
    if (k >= fromKey && k <= toKey) {
      kwh += d.kwh;
      costP += d.costP;
      coveredMs += d.ms;
    }
  }
  return { kwh, costP, coveredDays: coveredMs / DAY };
}

/**
 * Average daily cost over the most recent `windowDays` of recorded usage,
 * falling back to whatever history exists. Used for projections.
 */
export function recentDailyAverage(intervals, windowDays = 30, minHours = MIN_RATE_HOURS) {
  if (!intervals.length) return null;
  const end = intervals[intervals.length - 1].to;
  const start = end - windowDays * DAY;
  let costP = 0;
  let kwh = 0;
  let spanMs = 0;
  for (const iv of intervals) {
    const a = Math.max(iv.from, start);
    const b = iv.to;
    if (b <= a) continue;
    const frac = (b - a) / (iv.to - iv.from);
    costP += iv.cost.totalP * frac;
    kwh += iv.kwh * frac;
    spanMs += b - a;
  }
  if (!spanMs || spanMs < minHours * HOUR) return null;
  const days = spanMs / DAY;
  return { costP: costP / days, kwh: kwh / days, basedOnDays: days };
}

/**
 * The latest usage period long enough to average over: the last interval,
 * extended back over earlier back-to-back intervals until it spans at least
 * `minHours`. `enough` is false when all the history is shorter than that, in
 * which case only the totals (not the rates) are meaningful.
 */
export function latestPeriod(intervals, minHours = MIN_RATE_HOURS) {
  if (!intervals.length) return null;
  let i = intervals.length - 1;
  const p = {
    from: intervals[i].from,
    to: intervals[i].to,
    kwh: 0,
    dayKwh: 0,
    nightKwh: 0,
    units: 0,
    hasNight: intervals[i].nightUnits !== undefined,
    cost: { totalP: 0, missingTariff: false, noNightRate: false },
  };
  for (; i >= 0; i--) {
    const iv = intervals[i];
    // Stop at a gap (meter replaced, or a skipped bad reading).
    if (iv.to !== p.from && i !== intervals.length - 1) break;
    p.from = iv.from;
    p.kwh += iv.kwh;
    p.dayKwh += iv.dayKwh ?? iv.kwh;
    p.nightKwh += iv.nightKwh ?? 0;
    p.units += iv.units;
    p.cost.totalP += iv.cost.totalP;
    p.cost.missingTariff ||= iv.cost.missingTariff;
    p.cost.noNightRate ||= !!iv.cost.noNightRate;
    if (p.to - p.from >= minHours * HOUR) break;
  }
  p.enough = p.to - p.from >= minHours * HOUR;
  p.rates = rates(p, p.cost);
  return p;
}
