// Run with TZ=Europe/London (see package.json "test" script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toKwh,
  buildIntervals,
  tariffSegments,
  mergeRateSeries,
  costInterval,
  analyseFuel,
  sumDays,
  recentDailyAverage,
  rates,
} from '../src/calc.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('gas m3 converts with volume correction and calorific value', () => {
  // 100 m3 × 1.02264 × 39.5 / 3.6 = 1122.063...
  near(toKwh('gas', 100, { units: 'm3', calorificValue: 39.5 }), 1122.0633333, 1e-4);
});

test('gas imperial meters convert hundreds of cubic feet to m3 first', () => {
  near(toKwh('gas', 1, { units: 'ft3', calorificValue: 39.5 }), toKwh('gas', 2.83168, { units: 'm3' }));
});

test('electricity is already kWh', () => {
  assert.equal(toKwh('electricity', 42), 42);
});

test('intervals skip other fuels, sort by time and respect resets', () => {
  const readings = [
    { id: 'c', fuel: 'electricity', at: '2026-01-03T00:00:00Z', value: 120 },
    { id: 'a', fuel: 'electricity', at: '2026-01-01T00:00:00Z', value: 100 },
    { id: 'g', fuel: 'gas', at: '2026-01-02T00:00:00Z', value: 5 },
    { id: 'd', fuel: 'electricity', at: '2026-01-04T00:00:00Z', value: 3, reset: true },
    { id: 'e', fuel: 'electricity', at: '2026-01-05T00:00:00Z', value: 13 },
  ];
  const ivs = buildIntervals(readings, 'electricity');
  assert.deepEqual(ivs.map((i) => [i.startReadingId, i.endReadingId, i.units]), [
    ['a', 'c', 20],
    ['d', 'e', 10],
  ]);
});

test('negative usage is flagged invalid', () => {
  const ivs = buildIntervals(
    [
      { id: 'a', fuel: 'electricity', at: '2026-01-01T00:00:00Z', value: 100 },
      { id: 'b', fuel: 'electricity', at: '2026-01-02T00:00:00Z', value: 90 },
    ],
    'electricity',
  );
  assert.equal(ivs[0].invalid, true);
});

test('single manual tariff: energy + standing + 5% VAT', () => {
  const segs = tariffSegments(
    [{ fuel: 'electricity', supplier: 'manual', from: '2026-01-01T00:00:00Z', to: null, unitRate: 20, standingCharge: 50 }],
    'electricity',
  );
  // Two full days (GMT so local midnight == UTC midnight), 10 kWh.
  const iv = { from: Date.parse('2026-01-10T00:00:00Z'), to: Date.parse('2026-01-12T00:00:00Z'), kwh: 10 };
  const c = costInterval(iv, segs, 0.05);
  near(c.energyP, 200);
  near(c.standingP, 100);
  near(c.totalP, 315);
  assert.deepEqual(Object.keys(c.days), ['2026-01-10', '2026-01-11']);
  near(c.days['2026-01-10'].kwh, 5);
  near(c.days['2026-01-10'].costP, 157.5);
  assert.equal(c.missingTariff, false);
});

test('supplier switch mid-interval splits cost pro-rata by time', () => {
  const tariffs = [
    { fuel: 'gas', supplier: 'manual', from: '2026-01-01T00:00:00Z', to: '2026-01-11T00:00:00Z', unitRate: 6, standingCharge: 30 },
    { fuel: 'gas', supplier: 'manual', from: '2026-01-11T00:00:00Z', to: null, unitRate: 8, standingCharge: 20 },
  ];
  const segs = tariffSegments(tariffs, 'gas');
  const iv = { from: Date.parse('2026-01-10T00:00:00Z'), to: Date.parse('2026-01-12T00:00:00Z'), kwh: 100 };
  const c = costInterval(iv, segs, 0);
  near(c.energyP, 50 * 6 + 50 * 8);
  near(c.standingP, 30 + 20);
});

test('time without any tariff is flagged', () => {
  const segs = tariffSegments(
    [{ fuel: 'electricity', supplier: 'manual', from: '2026-01-11T00:00:00Z', to: null, unitRate: 10, standingCharge: 0 }],
    'electricity',
  );
  const c = costInterval({ from: Date.parse('2026-01-10T00:00:00Z'), to: Date.parse('2026-01-12T00:00:00Z'), kwh: 10 }, segs, 0);
  assert.equal(c.missingTariff, true);
  near(c.energyP, 50);
});

test('octopus rate series merge into constant segments', () => {
  const unit = [
    { from: '2026-01-01T00:00:00Z', to: '2026-04-01T00:00:00Z', value: 24 },
    { from: '2026-04-01T00:00:00Z', to: null, value: 22 },
  ];
  const standing = [{ from: '2025-10-01T00:00:00Z', to: null, value: 51 }];
  const segs = mergeRateSeries(unit, standing, Date.parse('2026-02-01T00:00:00Z'), null);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].from, Date.parse('2026-02-01T00:00:00Z'));
  assert.equal(segs[0].unit, 24);
  assert.equal(segs[1].unit, 22);
  assert.equal(segs[1].standing, 51);
  assert.equal(segs[1].to, null);
});

test('octopus tariff flattens via tariffSegments', () => {
  const segs = tariffSegments(
    [
      {
        fuel: 'electricity',
        supplier: 'octopus',
        from: '2026-01-01T00:00:00Z',
        to: null,
        rates: {
          unit: [{ from: '2025-12-01T00:00:00Z', to: null, value: 25 }],
          standing: [{ from: '2025-12-01T00:00:00Z', to: null, value: 50 }],
        },
      },
    ],
    'electricity',
  );
  assert.deepEqual(segs, [{ from: Date.parse('2026-01-01T00:00:00Z'), to: null, unit: 25, standing: 50 }]);
});

test('BST day boundaries follow UK local midnight', () => {
  const segs = [{ from: 0, to: null, unit: 10, standing: 0 }];
  // 2026-07-01 00:00 BST == 2026-06-30 23:00 UTC
  const iv = { from: Date.parse('2026-06-30T23:00:00Z'), to: Date.parse('2026-07-01T23:00:00Z'), kwh: 24 };
  const c = costInterval(iv, segs, 0);
  assert.deepEqual(Object.keys(c.days), ['2026-07-01']);
});

test('analyseFuel, sumDays, averages and projections', () => {
  const readings = [
    { id: '1', fuel: 'electricity', at: '2026-01-01T00:00:00Z', value: 1000 },
    { id: '2', fuel: 'electricity', at: '2026-01-08T00:00:00Z', value: 1070 },
  ];
  const tariffs = [{ fuel: 'electricity', supplier: 'manual', from: '2025-01-01T00:00:00Z', to: null, unitRate: 20, standingCharge: 40 }];
  const a = analyseFuel({ readings, tariffs, fuel: 'electricity', vatRate: 0 });
  assert.equal(a.intervals.length, 1);
  const iv = a.intervals[0];
  near(iv.cost.totalP, 70 * 20 + 7 * 40);
  const r = rates(iv, iv.cost);
  near(r.perDay.kwh, 10);
  near(r.perWeek.costP, 1680);
  near(r.perHour.kwh, 10 / 24);
  const week = sumDays(a.daily, '2026-01-01', '2026-01-03');
  near(week.kwh, 30);
  near(week.coveredDays, 3);
  const avg = recentDailyAverage(a.intervals, 30);
  near(avg.costP, 240);
  near(avg.basedOnDays, 7);
});
