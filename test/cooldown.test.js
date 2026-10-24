const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeNextAvailableAt } = require('../src/cooldown');

const interval3600 = { cooldownType: 0, intervalSec: 3600, resetTimesKST: null };
const daily00 = { cooldownType: 1, intervalSec: null, resetTimesKST: ['00:00'] };
const daily3 = { cooldownType: 1, intervalSec: null, resetTimesKST: ['00:00', '08:00', '16:00'] };

function next(content, nowIso) {
  return computeNextAvailableAt(content, new Date(nowIso)).toISOString();
}

test('C1 interval 3600초: 1시간 뒤', () => {
  assert.equal(next(interval3600, '2026-10-24T01:00:00.000Z'), '2026-10-24T02:00:00.000Z');
});

test('C2 dailyReset 00:00: 한국 23:59:59 → 한국 다음 날 00:00', () => {
  assert.equal(next(daily00, '2026-10-24T14:59:59.000Z'), '2026-10-24T15:00:00.000Z');
});

test('C3 dailyReset 00:00: 한국 정각 00:00:00 → 다음 날 (경계 규칙)', () => {
  assert.equal(next(daily00, '2026-10-24T15:00:00.000Z'), '2026-10-25T15:00:00.000Z');
});

test('C4 하루 3회: 한국 15:59:59 → 한국 16:00', () => {
  assert.equal(next(daily3, '2026-10-24T06:59:59.000Z'), '2026-10-24T07:00:00.000Z');
});

test('C5 하루 3회: 한국 16:00:00 → 한국 다음 날 00:00', () => {
  assert.equal(next(daily3, '2026-10-24T07:00:00.000Z'), '2026-10-24T15:00:00.000Z');
});

test('C6 하루 3회: 한국 07:59:59 → 한국 08:00', () => {
  assert.equal(next(daily3, '2026-10-23T22:59:59.000Z'), '2026-10-23T23:00:00.000Z');
});
