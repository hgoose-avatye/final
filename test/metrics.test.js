// 지표 계산(8장) 테스트. 손으로 만든 고정 이벤트와 손계산을 비교한다.
// 계산 함수는 순수 함수라서 DB가 필요 없다. (마지막 테스트만 /admin/metrics 라우트를 호출한다.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { computeFunnel, computeReentry, percentile } = require('../src/metrics');

const FROM = new Date('2026-10-24T00:00:00.000Z');
const TO = new Date('2026-10-24T12:00:00.000Z');

function ev(userID, eventType, contentID, iso, payload = null) {
  return { userID, eventType, contentID, occurredAt: new Date(iso), payload };
}

function stepUsers(funnelForContent) {
  return Object.fromEntries(funnelForContent.steps.map((s) => [s.step, s.users]));
}

// ---- 단계별 이벤트 발생자 수 ----

test('유저 3명이 홈에 들어와 2명이 콘텐츠에 들어가 1명이 적립: 단계별 이벤트 발생자 수', () => {
  const events = [
    ev(1, 'home_enter', null, '2026-10-24T01:00:00.000Z'),
    ev(2, 'home_enter', null, '2026-10-24T01:01:00.000Z'),
    ev(3, 'home_enter', null, '2026-10-24T01:02:00.000Z'),
    ev(1, 'cooldown_view', 1, '2026-10-24T01:00:01.000Z', { ready: true, nextAvailableAt: null }),
    ev(2, 'cooldown_view', 1, '2026-10-24T01:01:01.000Z', { ready: true, nextAvailableAt: null }),
    ev(3, 'cooldown_view', 1, '2026-10-24T01:02:01.000Z', { ready: true, nextAvailableAt: null }),
    ev(1, 'content_enter', 1, '2026-10-24T01:00:10.000Z'),
    ev(2, 'content_enter', 1, '2026-10-24T01:01:10.000Z'),
    ev(1, 'ad_start', 1, '2026-10-24T01:00:20.000Z'),
    ev(1, 'ad_complete', 1, '2026-10-24T01:00:25.000Z'),
    ev(1, 'claim_ok', 1, '2026-10-24T01:00:26.000Z', { nextAvailableAt: '2026-10-24T02:00:26.000Z' }),
  ];
  const [fishing] = computeFunnel(events, [1], FROM, TO);
  assert.equal(fishing.contentID, 1);
  assert.deepEqual(fishing.steps.map((s) => s.step), [
    'home_enter', 'cooldown_view', 'content_enter', 'ad_start', 'ad_complete', 'claim_ok',
  ]);
  assert.deepEqual(stepUsers(fishing), {
    home_enter: 3, cooldown_view: 3, content_enter: 2, ad_start: 1, ad_complete: 1, claim_ok: 1,
  });
});

test('같은 유저가 같은 이벤트를 여러 번 내도 한 명으로 센다', () => {
  const events = [
    ev(1, 'content_enter', 1, '2026-10-24T01:00:00.000Z'),
    ev(1, 'content_enter', 1, '2026-10-24T02:00:00.000Z'),
    ev(1, 'content_enter', 1, '2026-10-24T03:00:00.000Z'),
  ];
  const [fishing] = computeFunnel(events, [1], FROM, TO);
  assert.equal(stepUsers(fishing).content_enter, 1);
});

test('구간은 [from, to): from은 포함, to는 제외', () => {
  const events = [
    ev(1, 'content_enter', 1, '2026-10-23T23:59:59.999Z'), // from 직전: 제외
    ev(2, 'content_enter', 1, '2026-10-24T00:00:00.000Z'), // from 정각: 포함
    ev(3, 'content_enter', 1, '2026-10-24T11:59:59.999Z'), // to 직전: 포함
    ev(4, 'content_enter', 1, '2026-10-24T12:00:00.000Z'), // to 정각: 제외
  ];
  const [fishing] = computeFunnel(events, [1], FROM, TO);
  assert.equal(stepUsers(fishing).content_enter, 2);
});

test('콘텐츠별로 센다. home_enter는 contentID가 없어 모든 콘텐츠에 같은 값을 쓴다', () => {
  const events = [
    ev(1, 'home_enter', null, '2026-10-24T01:00:00.000Z'),
    ev(2, 'home_enter', null, '2026-10-24T01:00:00.000Z'),
    ev(1, 'content_enter', 1, '2026-10-24T01:01:00.000Z'),
    ev(1, 'content_enter', 2, '2026-10-24T01:02:00.000Z'),
    ev(2, 'content_enter', 2, '2026-10-24T01:03:00.000Z'),
  ];
  const [fishing, attendance] = computeFunnel(events, [1, 2], FROM, TO);
  assert.equal(stepUsers(fishing).home_enter, 2);
  assert.equal(stepUsers(attendance).home_enter, 2);
  assert.equal(stepUsers(fishing).content_enter, 1);
  assert.equal(stepUsers(attendance).content_enter, 2);
});

test('이벤트가 없으면 모든 단계가 0명', () => {
  const [fishing] = computeFunnel([], [1], FROM, TO);
  assert.ok(fishing.steps.every((s) => s.users === 0));
});

// ---- 재진입 지연 ----

// 재진입 테스트용: 유저 u가 10:00:00에 적립(다음 가능 시각 N=11:00:00)하고, 돌아온 시각들을 넣는다.
const CLAIM_AT = '2026-10-24T10:00:00.000Z';
const N = '2026-10-24T11:00:00.000Z';
const claimOk = (userID, contentID = 1, next = N) =>
  ev(userID, 'claim_ok', contentID, CLAIM_AT, { rewardID: userID, amount: 2, nextAvailableAt: next });
const REENTRY_TO = new Date('2026-10-24T13:00:00.000Z'); // 돌아온 시각을 찾을 수 있게 구간을 넓힌다

test('쿨타임 종료 120초 뒤에 돌아온 유저 → 지연 120초', () => {
  const events = [claimOk(1), ev(1, 'content_enter', 1, '2026-10-24T11:02:00.000Z')];
  const [fishing] = computeReentry(events, [1], FROM, REENTRY_TO);
  assert.deepEqual(fishing, { contentID: 1, returned: 1, notReturned: 0, p50Sec: 120, p90Sec: 120 });
});

test('N 이전에 들어온 content_enter만 있으면 notReturned로 센다', () => {
  const events = [claimOk(1), ev(1, 'content_enter', 1, '2026-10-24T10:30:00.000Z')];
  const [fishing] = computeReentry(events, [1], FROM, REENTRY_TO);
  assert.deepEqual(fishing, { contentID: 1, returned: 0, notReturned: 1, p50Sec: null, p90Sec: null });
});

test('N 이전 진입은 무시하고, N 이후 가장 이른 진입을 쓴다 (N 정각은 포함, 지연 0)', () => {
  const events = [
    claimOk(1),
    ev(1, 'content_enter', 1, '2026-10-24T10:59:50.000Z'), // N보다 10초 전: 무시
    ev(1, 'content_enter', 1, '2026-10-24T11:00:30.000Z'), // 가장 이른 N 이후 진입: 30초
    ev(1, 'content_enter', 1, '2026-10-24T11:08:20.000Z'), // 더 늦은 진입: 무시
    claimOk(2),
    ev(2, 'content_enter', 1, N), // 정확히 N: 지연 0
  ];
  const [fishing] = computeReentry(events, [1], FROM, REENTRY_TO);
  assert.equal(fishing.returned, 2);
  assert.equal(fishing.notReturned, 0);
  assert.equal(fishing.p50Sec, 0); // 정렬 [0, 30] → ceil(0.5 × 2) = 1번째 = 0
  assert.equal(fishing.p90Sec, 30); // ceil(0.9 × 2) = 2번째 = 30
});

test('지연 값이 [60, 120, 540, 600]이면 p50Sec = 120, p90Sec = 600 (nearest-rank)', () => {
  const delays = [60, 120, 540, 600];
  const events = [];
  delays.forEach((delaySec, i) => {
    const userID = i + 1;
    events.push(claimOk(userID));
    events.push(ev(userID, 'content_enter', 1, new Date(Date.parse(N) + delaySec * 1000).toISOString()));
  });
  const [fishing] = computeReentry(events, [1], FROM, REENTRY_TO);
  assert.equal(fishing.returned, 4);
  assert.equal(fishing.p50Sec, 120);
  assert.equal(fishing.p90Sec, 600);
});

test('구간의 끝(to) 이후의 진입은 찾지 않는다 → notReturned', () => {
  const events = [claimOk(1), ev(1, 'content_enter', 1, '2026-10-24T11:30:00.000Z')];
  const to = new Date('2026-10-24T11:30:00.000Z'); // 진입 시각이 정확히 to: 제외
  const [fishing] = computeReentry(events, [1], FROM, to);
  assert.equal(fishing.returned, 0);
  assert.equal(fishing.notReturned, 1);
});

test('다른 유저나 다른 콘텐츠의 진입은 재진입으로 세지 않는다', () => {
  const events = [
    claimOk(1),
    ev(2, 'content_enter', 1, '2026-10-24T11:05:00.000Z'), // 다른 유저
    ev(1, 'content_enter', 2, '2026-10-24T11:05:00.000Z'), // 다른 콘텐츠
  ];
  const [fishing, attendance] = computeReentry(events, [1, 2], FROM, REENTRY_TO);
  assert.equal(fishing.returned, 0);
  assert.equal(fishing.notReturned, 1);
  assert.deepEqual(attendance, { contentID: 2, returned: 0, notReturned: 0, p50Sec: null, p90Sec: null });
});

test('구간 밖의 claim_ok는 대상이 아니다', () => {
  const events = [
    ev(1, 'claim_ok', 1, '2026-10-23T10:00:00.000Z', { nextAvailableAt: '2026-10-23T11:00:00.000Z' }),
    ev(1, 'content_enter', 1, '2026-10-24T01:00:00.000Z'),
  ];
  const [fishing] = computeReentry(events, [1], FROM, REENTRY_TO);
  assert.equal(fishing.returned + fishing.notReturned, 0);
});

test('percentile: nearest-rank, 값이 없으면 null', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([60, 120, 540, 600], 0.5), 120);
  assert.equal(percentile([60, 120, 540, 600], 0.9), 600);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9); // ceil(0.9 × 10) = 9번째
});

// ---- GET /admin/metrics ----

const pool = require('../src/db');
const app = require('../src/server');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await pool.end();
});

test('/admin/metrics: 운영자 토큰이 없거나 틀리면 403', async () => {
  const none = await fetch(`${baseUrl}/admin/metrics`);
  assert.equal(none.status, 403);
  assert.deepEqual(await none.json(), { error: 'forbidden' });

  const wrong = await fetch(`${baseUrl}/admin/metrics`, { headers: { 'X-Admin-Token': 'wrong' } });
  assert.equal(wrong.status, 403);
});

test('/admin/metrics: 올바른 토큰이면 8장 형식의 JSON (콘텐츠마다 한 줄)', async () => {
  const url = `${baseUrl}/admin/metrics?from=2000-01-01T00:00:00.000Z&to=2000-01-02T00:00:00.000Z`;
  const res = await fetch(url, { headers: { 'X-Admin-Token': process.env.ADMIN_TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.from, '2000-01-01T00:00:00.000Z');
  assert.equal(body.to, '2000-01-02T00:00:00.000Z');
  assert.deepEqual(body.funnel.map((f) => f.contentID), [1, 2]);
  assert.equal(body.funnel[0].steps.length, 6);
  assert.deepEqual(body.reentry.map((r) => r.contentID), [1, 2]);
  assert.deepEqual(body.reentry[0], { contentID: 1, returned: 0, notReturned: 0, p50Sec: null, p90Sec: null });
});

test('/admin/metrics: from, to가 없으면 오늘 00:00 KST부터 지금까지', async () => {
  const res = await fetch(`${baseUrl}/admin/metrics`, { headers: { 'X-Admin-Token': process.env.ADMIN_TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const from = Date.parse(body.from);
  const to = Date.parse(body.to);
  // 한국 시간 00:00 = UTC 15:00 (전날). 그래서 from의 UTC 시각은 항상 15:00:00.000이다.
  assert.equal(new Date(from).toISOString().slice(11), '15:00:00.000Z');
  assert.ok(to > from && to - from <= 24 * 3600 * 1000);
});

test('/admin/metrics: 읽을 수 없는 시각이면 400 invalid_range', async () => {
  const res = await fetch(`${baseUrl}/admin/metrics?from=not-a-date`, { headers: { 'X-Admin-Token': process.env.ADMIN_TOKEN } });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'invalid_range' });
});
