const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeNextAvailableAt, kstDayStart, nextKstMidnight, remainingTodayOf, limitAwareNextAvailableAt } = require('../src/cooldown');

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

// ---- 하루 한도의 "하루" 경계 (M7, 한국 시간 00:00) ----

const dayStart = (nowIso) => kstDayStart(new Date(nowIso)).toISOString();

test('C7 kstDayStart: 한국 23:59:59.999 → 그 날(한국 날짜)의 00:00', () => {
  assert.equal(dayStart('2026-10-24T14:59:59.999Z'), '2026-10-23T15:00:00.000Z');
});

test('C8 kstDayStart: 한국 정확히 00:00:00.000 → 그 날의 시작 (nextReset의 "엄격하게 크다"와 다르다)', () => {
  assert.equal(dayStart('2026-10-24T15:00:00.000Z'), '2026-10-24T15:00:00.000Z');
});

test('kstDayStart: 한국 00:00:00.001과 한낮도 같은 날의 시작', () => {
  assert.equal(dayStart('2026-10-24T15:00:00.001Z'), '2026-10-24T15:00:00.000Z');
  assert.equal(dayStart('2026-10-25T03:00:00.000Z'), '2026-10-24T15:00:00.000Z'); // 한국 12:00
});

test('nextKstMidnight: 그 날의 시작 + 24시간. 정각이면 다음 날 00:00', () => {
  assert.equal(nextKstMidnight(new Date('2026-10-24T14:59:59.999Z')).toISOString(), '2026-10-24T15:00:00.000Z');
  assert.equal(nextKstMidnight(new Date('2026-10-24T15:00:00.000Z')).toISOString(), '2026-10-25T15:00:00.000Z');
});

// ---- 하루 한도의 남은 횟수와 "다시 할 수 있는 시각" (GET /cooldowns와 claim 응답이 공유하는 계산) ----

const NOW = new Date('2026-10-24T05:00:00.000Z'); // 한국 14:00
const TODAY_START = kstDayStart(NOW); // 2026-10-23T15:00:00.000Z
const YESTERDAY_START = new Date(TODAY_START.getTime() - 24 * 3600 * 1000);

test('remainingTodayOf: 한도가 없으면 null', () => {
  assert.equal(remainingTodayOf({ dailyLimit: null, todayCount: 3, countDayStart: TODAY_START }, NOW), null);
});

test('remainingTodayOf: 오늘 센 값이면 한도에서 빼고, 어제 값이거나 행이 처음이면 한도 그대로', () => {
  assert.equal(remainingTodayOf({ dailyLimit: 10, todayCount: 3, countDayStart: TODAY_START }, NOW), 7);
  assert.equal(remainingTodayOf({ dailyLimit: 10, todayCount: 9, countDayStart: YESTERDAY_START }, NOW), 10);
  assert.equal(remainingTodayOf({ dailyLimit: 10, todayCount: null, countDayStart: null }, NOW), 10); // 행이 없다 (LEFT JOIN)
});

test('remainingTodayOf: 센 횟수가 한도를 넘어도 0 아래로 내려가지 않는다', () => {
  assert.equal(remainingTodayOf({ dailyLimit: 2, todayCount: 5, countDayStart: TODAY_START }, NOW), 0);
  assert.equal(remainingTodayOf({ dailyLimit: 2, todayCount: 2, countDayStart: TODAY_START }, NOW), 0);
});

test('limitAwareNextAvailableAt: 한도가 남았거나(양수) 한도가 없으면(null) 저장된 쿨타임 그대로', () => {
  const stored = new Date('2026-10-24T06:00:00.000Z');
  assert.equal(limitAwareNextAvailableAt(stored, 3, NOW).toISOString(), stored.toISOString());
  assert.equal(limitAwareNextAvailableAt(stored, null, NOW).toISOString(), stored.toISOString());
});

test('limitAwareNextAvailableAt: 한도가 다 찼으면 다음 한국 00:00, 단 저장된 쿨타임이 더 늦으면 그 값', () => {
  const midnight = '2026-10-24T15:00:00.000Z'; // 한국 다음 날 00:00
  // 쿨타임이 자정보다 이르다 → 자정
  assert.equal(limitAwareNextAvailableAt(new Date('2026-10-24T06:00:00.000Z'), 0, NOW).toISOString(), midnight);
  // 쿨타임이 자정보다 늦다(자정 직전 적립) → 그 값
  assert.equal(limitAwareNextAvailableAt(new Date('2026-10-24T15:30:00.000Z'), 0, NOW).toISOString(), '2026-10-24T15:30:00.000Z');
  // 정확히 자정이면 같은 값
  assert.equal(limitAwareNextAvailableAt(new Date(midnight), 0, NOW).toISOString(), midnight);
  // 행이 없어서 저장된 값이 없다
  assert.equal(limitAwareNextAvailableAt(null, 0, NOW).toISOString(), midnight);
});
