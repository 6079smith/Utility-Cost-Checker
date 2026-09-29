import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLabel, mapRegisters, looksSwapped } from '../src/registers.js';

test('classifies common UK register labels', () => {
  const cases = {
    Low: 'night',
    Normal: 'day',
    Night: 'night',
    Day: 'day',
    'Off-peak': 'night',
    Peak: 'day',
    'Rate 1': 'rate1',
    'RATE 2': 'rate2',
    R01: 'rate1',
    'IMP R2': 'rate2',
    T1: 'rate1',
    '1.8.1': 'rate1',
    '1.8.2': 'rate2',
    '1.8.0': 'total',
    Total: 'total',
    'top row': 'unknown',
    single: 'unknown',
  };
  for (const [label, want] of Object.entries(cases)) assert.equal(classifyLabel(label), want, label);
});

test('maps Low/Normal regardless of order', () => {
  assert.deepEqual(mapRegisters([{ label: 'Normal', value: 5 }, { label: 'Low', value: 9 }]), { day: 5, night: 9, ambiguous: false });
});

test('Rate 1/Rate 2 follow the setting', () => {
  const regs = [{ label: 'Rate 1', value: 100 }, { label: 'Rate 2', value: 200 }];
  assert.deepEqual(mapRegisters(regs, 'night'), { day: 200, night: 100, ambiguous: false });
  assert.deepEqual(mapRegisters(regs, 'day'), { day: 100, night: 200, ambiguous: false });
});

test('one digital screen fills just its register', () => {
  assert.deepEqual(mapRegisters([{ label: '1.8.2', value: 42 }], 'night'), { day: 42, night: null, ambiguous: false });
});

test('unlabelled rows are guessed in order and flagged', () => {
  assert.deepEqual(mapRegisters([{ label: 'top row', value: 1 }, { label: 'bottom row', value: 2 }]), { day: 1, night: 2, ambiguous: true });
});

test('one known label lets the other row take the remaining slot', () => {
  assert.deepEqual(mapRegisters([{ label: 'top row', value: 1 }, { label: 'Low', value: 2 }]), { day: 1, night: 2, ambiguous: true });
});

test('total register is ignored when rate registers exist', () => {
  assert.deepEqual(mapRegisters([{ label: '1.8.0', value: 300 }, { label: '1.8.1', value: 100 }, { label: '1.8.2', value: 200 }], 'day'), {
    day: 100,
    night: 200,
    ambiguous: false,
  });
});

test('detects swapped day/night against the previous reading', () => {
  const prev = { value: 1000, night: 5000 };
  assert.equal(looksSwapped(5010, 1004, prev), true);
  assert.equal(looksSwapped(1004, 5010, prev), false);
  assert.equal(looksSwapped(5010, 1004, { value: 1000 }), false);
});
