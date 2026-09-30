import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAdd, planEdit, validate, SINCE_START } from '../src/tariffPlan.js';

const d = (s) => new Date(s + 'T00:00:00Z').toISOString();
const T = (id, from, to = null) => ({ id, label: id, from: from === 'start' ? SINCE_START : d(from), to: to ? d(to) : null });

test('adding an open-ended tariff closes the current one', () => {
  const r = planAdd([T('old', 'start')], T('new', '2026-09-30'));
  assert.equal(r.ok, true);
  assert.equal(r.list.find((x) => x.id === 'old').to, d('2026-09-30'));
  assert.equal(r.list.find((x) => x.id === 'new').to, null);
});

test('a past contract trims a "from the start" tariff', () => {
  const r = planAdd([T('current', 'start')], T('past', '2025-08-17', '2026-08-17'));
  assert.equal(r.ok, true);
  assert.equal(r.list.find((x) => x.id === 'current').from, d('2026-08-17'));
  assert.equal(validate(r.list), null);
});

test('back-to-back contracts are fine, overlapping ones are refused', () => {
  const list = [T('a', '2025-08-17', '2026-08-17'), T('b', '2026-08-17')];
  assert.equal(planAdd(list, T('c', '2024-08-17', '2025-08-17')).ok, true);
  const bad = planAdd(list, T('c', '2025-01-01', '2025-09-01'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /overlap a/);
});

test('open-ended tariff starting before the current one is refused', () => {
  const r = planAdd([T('a', '2026-08-17')], T('b', '2026-01-01'));
  assert.equal(r.ok, false);
});

test('end must be after start', () => {
  assert.equal(planAdd([], T('a', '2026-08-17', '2026-08-01')).ok, false);
});

test('editing dates refuses overlaps and a second open tariff', () => {
  const list = [T('a', '2025-08-17', '2026-08-17'), T('b', '2026-08-17')];
  assert.equal(planEdit(list, 'a', d('2025-08-01'), d('2026-08-17')).ok, true);
  assert.equal(planEdit(list, 'a', d('2025-08-01'), d('2026-09-01')).ok, false);
  assert.equal(planEdit(list, 'a', d('2025-08-01'), null).ok, false);
  assert.equal(planEdit(list, 'b', d('2026-08-20'), null).ok, true);
});

test('validate spots overlaps and misplaced open tariffs', () => {
  assert.equal(validate([T('a', '2025-01-01', '2025-06-01'), T('b', '2025-05-01')]), 'Two tariffs overlap.');
  assert.equal(validate([T('a', '2025-01-01'), T('b', '2025-06-01', '2025-07-01')]), 'Only the latest tariff can have no end date.');
  assert.equal(validate([T('a', '2025-01-01', '2025-06-01'), T('b', '2025-06-01')]), null);
});
