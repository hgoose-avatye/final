// 적립 관문(5-3)과 모의 광고(6-2, 6-3)의 통합 테스트. Docker MySQL이 떠 있어야 한다.
// 테스트마다 content를 뺀 테이블을 비운다 (content는 seed 유지).
process.env.AD_MIN_SECONDS = '0'; // app을 불러오기 전에 둔다. 테스트에서는 완료 요청을 바로 받는다.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/db');
const app = require('../src/server');
const { makeToken } = require('../src/auth');
const { computeNextAvailableAt, kstDayStart, nextKstMidnight } = require('../src/cooldown');

// 테스트가 만드는 임시 콘텐츠는 "아주 큰 ID 범위"와 "이름 표식"을 모두 가진다.
// 이유: 개발 DB에 직접 만들어 둔 실제 콘텐츠(예: 100번)를 정리가 지우지 않게 한다. INT 범위(21억) 안의 값이라 라우트 검증도 통과한다.
// 테스트 전용 ID는 TEST_CONTENT_ID_BASE + n (900000001, 900000002, ...)이다.
// 이 블록은 아래 before/after 훅보다 위에 있어야 한다: 최상위 before는 등록되는 순간 실행되어, 뒤에 선언된 const는 아직 만들어지기 전이다.
const TEST_CONTENT_ID_BASE = 900000000;
const TEST_CONTENT_NAME = '[테스트]';

async function cleanupTestContent() {
  await pool.query('DELETE FROM content WHERE contentID >= ? AND name = ?', [TEST_CONTENT_ID_BASE, TEST_CONTENT_NAME]);
}

let server;
let baseUrl;

before(async () => {
  await cleanupTestContent(); // 이전 실행이 중간에 죽었을 때 남은 임시 콘텐츠
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    await cleanupTestContent(); // 프로세스가 정상 종료될 때도 임시 콘텐츠를 남기지 않는다
  } finally {
    // before가 실패해서 server가 없어도 연결은 반드시 닫는다. 안 닫으면 테스트 프로세스가 끝나지 않고 멈춘다.
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    await pool.end();
  }
});

beforeEach(async () => {
  for (const table of ['user_content_state', 'ad_impression', 'reward', 'event_log']) {
    await pool.query(`TRUNCATE TABLE ${table}`);
  }
});

// ---- 도우미 ----

const tokenFor = (userID) => makeToken(userID);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function startImpression(userID, contentID) {
  const res = await call('POST', '/ads/impressions', { token: tokenFor(userID), body: { contentID } });
  assert.equal(res.status, 200);
  return res.body.impressionID;
}

async function completedImpression(userID, contentID) {
  const impressionID = await startImpression(userID, contentID);
  const res = await call('POST', `/ads/impressions/${impressionID}/complete`, { token: tokenFor(userID) });
  assert.equal(res.status, 200);
  return impressionID;
}

function claim(userID, contentID, impressionID) {
  return call('POST', `/contents/${contentID}/claim`, {
    token: tokenFor(userID),
    body: { impressionID },
  });
}

async function rows(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

// ---- 모의 광고 (6-2, 6-3) ----

test('광고 시작: 응답 형식과 ad_start 이벤트', async () => {
  const res = await call('POST', '/ads/impressions', { token: tokenFor(1), body: { contentID: 1 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.adFormat, 'install');
  assert.equal(res.body.advertiser, '토스');
  assert.equal(typeof res.body.impressionID, 'number');
  assert.equal(typeof res.body.minWatchSec, 'number');
  assert.equal(typeof res.body.adSeconds, 'number');

  const events = await rows("SELECT * FROM event_log WHERE eventType = 'ad_start'");
  assert.equal(events.length, 1);
  assert.equal(events[0].userID, 1);
  assert.equal(events[0].contentID, 1);
  assert.equal(events[0].payload.impressionID, res.body.impressionID);
});

test('광고 시작: 없는 콘텐츠는 404 content_not_found', async () => {
  const res = await call('POST', '/ads/impressions', { token: tokenFor(1), body: { contentID: 999 } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'content_not_found');
  assert.equal((await rows('SELECT * FROM ad_impression')).length, 0);
});

test('광고 완료: 두 번 불러도 200이고 ad_complete 이벤트는 한 번', async () => {
  const impressionID = await startImpression(1, 1);
  const first = await call('POST', `/ads/impressions/${impressionID}/complete`, { token: tokenFor(1) });
  const second = await call('POST', `/ads/impressions/${impressionID}/complete`, { token: tokenFor(1) });
  assert.deepEqual(first.body, { completed: true });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { completed: true });
  const events = await rows("SELECT * FROM event_log WHERE eventType = 'ad_complete'");
  assert.equal(events.length, 1);
});

test('광고 완료: 남의 노출은 404 impression_not_found', async () => {
  const impressionID = await startImpression(1, 1);
  const res = await call('POST', `/ads/impressions/${impressionID}/complete`, { token: tokenFor(2) });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'impression_not_found');
});

test('광고 완료: 최소 시청 시간 전이면 400 too_early + retryAfterMs, 완료 처리되지 않는다', async () => {
  const impressionID = await startImpression(1, 1);
  process.env.AD_MIN_SECONDS = '3';
  try {
    const res = await call('POST', `/ads/impressions/${impressionID}/complete`, { token: tokenFor(1) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'too_early');
    assert.ok(res.body.retryAfterMs > 0 && res.body.retryAfterMs <= 3000);
  } finally {
    process.env.AD_MIN_SECONDS = '0';
  }
  const [imp] = await rows('SELECT * FROM ad_impression WHERE impressionID = ?', [impressionID]);
  assert.equal(imp.completedAt, null);
  assert.equal((await rows("SELECT * FROM event_log WHERE eventType = 'ad_complete'")).length, 0);
});

// ---- 적립 (5-3, 6-4) ----

test('A1 처음 적립: 200, reward 1행, 쿨타임은 5-1 규칙, claim_ok 1건, 시각은 now 하나', async () => {
  const impressionID = await completedImpression(1, 1);
  const res = await claim(1, 1, impressionID);

  assert.equal(res.status, 200);
  assert.equal(res.body.rewardType, 'ticket');
  assert.equal(res.body.amount, 2);
  assert.equal(typeof res.body.rewardID, 'number');

  const rewards = await rows('SELECT * FROM reward');
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].rewardID, res.body.rewardID);
  assert.equal(rewards[0].impressionID, impressionID);
  assert.equal(rewards[0].amount, 2);

  const [state] = await rows('SELECT * FROM user_content_state WHERE userID = 1 AND contentID = 1');
  assert.equal(state.nextAvailableAt.getTime() - state.lastRewardAt.getTime(), 3600 * 1000);
  assert.equal(state.nextAvailableAt.toISOString(), res.body.nextAvailableAt);

  const events = await rows("SELECT * FROM event_log WHERE eventType = 'claim_ok'");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.rewardID, res.body.rewardID);
  assert.equal(events[0].payload.nextAvailableAt, res.body.nextAvailableAt);
  // 3번에서 읽은 now 하나를 lastRewardAt, reward.createdAt, 이벤트 시각에 같이 쓴다.
  assert.equal(rewards[0].createdAt.getTime(), state.lastRewardAt.getTime());
  assert.equal(events[0].occurredAt.getTime(), state.lastRewardAt.getTime());

  const [imp] = await rows('SELECT * FROM ad_impression WHERE impressionID = ?', [impressionID]);
  assert.equal(imp.used, 1);
});

test('A2 쿨타임 중 다시 claim: 409 cooldown_active, reward 그대로, 두 번째 노출 소진, claim_rejected', async () => {
  const first = await completedImpression(1, 1);
  const ok = await claim(1, 1, first);
  assert.equal(ok.status, 200);

  const second = await completedImpression(1, 1);
  const res = await claim(1, 1, second);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'cooldown_active');
  assert.equal(res.body.nextAvailableAt, ok.body.nextAvailableAt);

  assert.equal((await rows('SELECT * FROM reward')).length, 1);
  const [imp] = await rows('SELECT * FROM ad_impression WHERE impressionID = ?', [second]);
  assert.equal(imp.used, 1);
  const events = await rows("SELECT * FROM event_log WHERE eventType = 'claim_rejected'");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, 'cooldown_active');
  assert.equal(events[0].payload.nextAvailableAt, ok.body.nextAvailableAt);
});

async function assertConcurrentClaims100(userID) {
  const impressionIDs = await Promise.all(Array.from({ length: 100 }, () => completedImpression(userID, 1)));
  const results = await Promise.all(impressionIDs.map((id) => claim(userID, 1, id)));

  const ok = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status === 409 && r.body.error === 'cooldown_active');
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 99);
  assert.equal(results.filter((r) => r.status >= 500).length, 0);
  // 거절 응답의 nextAvailableAt은 이긴 요청이 저장한 값이어야 한다 (오래된 스냅샷 값이면 안 된다).
  for (const r of rejected) {
    assert.equal(r.body.nextAvailableAt, ok[0].body.nextAvailableAt);
  }

  assert.equal((await rows('SELECT * FROM reward')).length, 1);
  assert.equal((await rows("SELECT * FROM event_log WHERE eventType = 'claim_ok'")).length, 1);
  assert.equal((await rows("SELECT * FROM event_log WHERE eventType = 'claim_rejected'")).length, 99);
  assert.equal((await rows('SELECT * FROM ad_impression WHERE used = 0')).length, 0);
}

test('A3 동시 claim 100개 (처음 적립인 유저): 200 한 번, 409 99번, reward 1행, 5xx 0건', async () => {
  await assertConcurrentClaims100(1);
});

test('A3 동시 claim 100개 (쿨타임이 끝난 기존 행이 있는 유저)', async () => {
  await pool.query(
    "INSERT INTO user_content_state (userID, contentID, lastRewardAt, nextAvailableAt) VALUES (1, 1, '2000-01-01 00:00:00.000', '2000-01-01 01:00:00.000')"
  );
  await assertConcurrentClaims100(1);
});

test('A4 같은 노출로 동시 claim 2개: 200 하나, 409 impression_used 하나, reward 1행', async () => {
  const impressionID = await completedImpression(1, 1);
  const results = await Promise.all([claim(1, 1, impressionID), claim(1, 1, impressionID)]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  const rejected = results.find((r) => r.status === 409);
  assert.equal(rejected.body.error, 'impression_used');
  assert.equal((await rows('SELECT * FROM reward')).length, 1);
});

test('A5 완료하지 않은 노출로 claim: 409 ad_not_completed, 상태 변화 없음', async () => {
  const impressionID = await startImpression(1, 1);
  const res = await claim(1, 1, impressionID);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'ad_not_completed');

  assert.equal((await rows('SELECT * FROM reward')).length, 0);
  // 5번(행 생성)이 먼저 실행되므로 빈 행이 있을 수 있다. 있다면 초기값 그대로여야 한다.
  for (const state of await rows('SELECT * FROM user_content_state')) {
    assert.equal(state.lastRewardAt, null);
    assert.equal(state.nextAvailableAt.getTime(), 0);
  }
  const [imp] = await rows('SELECT * FROM ad_impression WHERE impressionID = ?', [impressionID]);
  assert.equal(imp.used, 0);
  const events = await rows("SELECT * FROM event_log WHERE eventType = 'claim_rejected'");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, 'ad_not_completed');
});

test('A6 다른 유저의 impressionID로 claim: 404 impression_not_found', async () => {
  const impressionID = await completedImpression(1, 1);
  const res = await claim(2, 1, impressionID);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'impression_not_found');
  const [imp] = await rows('SELECT * FROM ad_impression WHERE impressionID = ?', [impressionID]);
  assert.equal(imp.used, 0);
});

test('A7 다른 contentID의 노출로 claim: 400 content_mismatch', async () => {
  const impressionID = await completedImpression(1, 2);
  const res = await claim(1, 1, impressionID);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'content_mismatch');
  assert.equal((await rows('SELECT * FROM reward')).length, 0);
});

test('A8 토큰 없음 / 서명이 틀린 토큰: 401', async () => {
  const noToken = await call('POST', '/contents/1/claim', { body: { impressionID: 1 } });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.error, 'unauthorized');

  const forged = await call('POST', '/contents/1/claim', { token: '1.deadbeef', body: { impressionID: 1 } });
  assert.equal(forged.status, 401);

  const ads = await call('POST', '/ads/impressions', { body: { contentID: 1 } });
  assert.equal(ads.status, 401);
});

test('A11 서로 다른 두 유저가 동시에 같은 콘텐츠 claim: 둘 다 200', async () => {
  const [imp1, imp2] = await Promise.all([completedImpression(1, 1), completedImpression(2, 1)]);
  const results = await Promise.all([claim(1, 1, imp1), claim(2, 1, imp2)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal((await rows('SELECT * FROM reward')).length, 2);
});

test('A12 낚시 claim 직후 출석체크 claim: 둘 다 200, 출석체크는 dailyReset 규칙', async () => {
  const fishing = await completedImpression(1, 1);
  const attendance = await completedImpression(1, 2);
  const first = await claim(1, 1, fishing);
  const second = await claim(1, 2, attendance);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.rewardType, 'point');
  assert.equal(second.body.amount, 6);

  const [content] = await rows('SELECT * FROM content WHERE contentID = 2');
  const [state] = await rows('SELECT * FROM user_content_state WHERE userID = 1 AND contentID = 2');
  const expected = computeNextAvailableAt(content, state.lastRewardAt);
  assert.equal(second.body.nextAvailableAt, expected.toISOString());
});

// ---- 이벤트 수집 (6-5) ----

function postEvents(userID, events) {
  return call('POST', '/events', { token: tokenFor(userID), body: { events } });
}

test('이벤트 수집: 클라이언트 4종을 저장하고 userID는 토큰에서만 정한다', async () => {
  const res = await postEvents(1, [
    { eventType: 'home_enter' },
    { eventType: 'cooldown_view', contentID: 1, payload: { ready: false, nextAvailableAt: '2026-10-24T02:12:00.000Z' } },
    { eventType: 'content_enter', contentID: 2 },
    { eventType: 'alarm_shown', contentID: 1, payload: { channel: 'toast' }, userID: 999 },
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { saved: 4 });

  const events = await rows('SELECT * FROM event_log ORDER BY eventID');
  assert.deepEqual(events.map((e) => e.eventType), ['home_enter', 'cooldown_view', 'content_enter', 'alarm_shown']);
  assert.ok(events.every((e) => e.userID === 1)); // 본문의 userID(999)는 무시한다
  assert.equal(events[0].contentID, null);
  assert.equal(events[1].contentID, 1);
  assert.equal(events[1].payload.ready, false);
  assert.equal(events[3].payload.channel, 'toast');
});

test('A9 서버 전용 이벤트(ad_start)나 알 수 없는 타입이 섞이면 400 invalid_event_type, 저장 0건', async () => {
  const serverOnly = await postEvents(1, [{ eventType: 'home_enter' }, { eventType: 'ad_start', contentID: 1 }]);
  assert.equal(serverOnly.status, 400);
  assert.equal(serverOnly.body.error, 'invalid_event_type');

  const unknown = await postEvents(1, [{ eventType: 'home_enter' }, { eventType: 'hacked' }]);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'invalid_event_type');

  assert.equal((await rows('SELECT * FROM event_log')).length, 0);
});

test('A10 과거의 occurredAt을 보내도 저장된 시각은 서버 시각', async () => {
  const res = await postEvents(1, [{ eventType: 'home_enter', occurredAt: '2000-01-01T00:00:00.000Z' }]);
  assert.equal(res.status, 200);
  const [event] = await rows('SELECT * FROM event_log');
  const [[{ now }]] = await pool.query('SELECT UTC_TIMESTAMP(3) AS now');
  assert.ok(Math.abs(now.getTime() - event.occurredAt.getTime()) < 5000);
  assert.ok(event.occurredAt.getUTCFullYear() >= 2026);
});

test('이벤트 수집: 50건은 저장하고 51건은 400 too_many (저장 0건)', async () => {
  const make = (n) => Array.from({ length: n }, () => ({ eventType: 'home_enter' }));
  const ok = await postEvents(1, make(50));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.saved, 50);

  const tooMany = await postEvents(1, make(51));
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error, 'too_many');
  assert.equal((await rows('SELECT * FROM event_log')).length, 50);
});

test('이벤트 수집: 토큰이 없으면 401', async () => {
  const res = await call('POST', '/events', { body: { events: [{ eventType: 'home_enter' }] } });
  assert.equal(res.status, 401);
});

// ---- 범위를 벗어난 ID (리뷰 L-1) ----

test('범위를 벗어난 contentID로 claim하면 404 content_not_found, 상태 행과 이벤트를 남기지 않는다', async () => {
  for (const id of ['99999999999', '9'.repeat(30), '2147483648']) {
    const res = await call('POST', `/contents/${id}/claim`, { token: tokenFor(1), body: { impressionID: 1 } });
    assert.equal(res.status, 404, `contentID ${id}`);
    assert.equal(res.body.error, 'content_not_found');
  }
  assert.equal((await rows('SELECT * FROM user_content_state')).length, 0);
  assert.equal((await rows('SELECT * FROM event_log')).length, 0);
});

test('안전하지 않은 정수 impressionID로 claim하면 404 impression_not_found', async () => {
  const res = await call('POST', '/contents/1/claim', { token: tokenFor(1), body: { impressionID: 9007199254740993 } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'impression_not_found');
  assert.equal((await rows('SELECT * FROM user_content_state')).length, 0);
});

test('범위를 벗어난 ID로 광고를 시작하거나 완료해도 404', async () => {
  const start = await call('POST', '/ads/impressions', { token: tokenFor(1), body: { contentID: 99999999999 } });
  assert.equal(start.status, 404);
  assert.equal(start.body.error, 'content_not_found');
  const complete = await call('POST', `/ads/impressions/${'9'.repeat(30)}/complete`, { token: tokenFor(1) });
  assert.equal(complete.status, 404);
  assert.equal(complete.body.error, 'impression_not_found');
});

// ---- 환경 변수 기본값 (리뷰 M-1) ----

test('AD_MIN_SECONDS가 없으면 스펙 기본값(3초)이 적용되어 too_early가 동작한다', async () => {
  const saved = process.env.AD_MIN_SECONDS;
  delete process.env.AD_MIN_SECONDS;
  try {
    const started = await call('POST', '/ads/impressions', { token: tokenFor(1), body: { contentID: 1 } });
    assert.equal(started.body.minWatchSec, 3);
    const early = await call('POST', `/ads/impressions/${started.body.impressionID}/complete`, { token: tokenFor(1) });
    assert.equal(early.status, 400);
    assert.equal(early.body.error, 'too_early');
  } finally {
    process.env.AD_MIN_SECONDS = saved;
  }
});

test('AD_SECONDS가 없으면 기본값 5초이고, AD_MIN_SECONDS=0은 기본값에 덮이지 않고 0으로 남는다', async () => {
  const savedSeconds = process.env.AD_SECONDS;
  delete process.env.AD_SECONDS;
  try {
    const started = await call('POST', '/ads/impressions', { token: tokenFor(1), body: { contentID: 1 } });
    assert.equal(started.body.adSeconds, 5);
    assert.equal(started.body.minWatchSec, 0); // 테스트 파일 맨 위에서 AD_MIN_SECONDS=0으로 둔 값이 기본값에 덮이지 않는다
  } finally {
    process.env.AD_SECONDS = savedSeconds;
  }
});

// ---- rollback 실패 (리뷰 L-3) ----

test('rollback이 실패해도 원래 에러가 가려지지 않고, 연결은 반납된다', async () => {
  const originalGetConnection = pool.getConnection.bind(pool);
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  let released = 0;

  // claim의 1번 조회에서 일부러 실패시키고, rollback도 실패시킨다 (실제 rollback은 실행해서 연결은 깨끗하게 둔다).
  pool.getConnection = async () => {
    const conn = await originalGetConnection();
    const realQuery = conn.query.bind(conn);
    const realRollback = conn.rollback.bind(conn);
    const realRelease = conn.release.bind(conn);
    conn.query = async (sql, ...rest) => {
      if (/FROM ad_impression/.test(sql)) throw new Error('boom');
      return realQuery(sql, ...rest);
    };
    conn.rollback = async () => {
      await realRollback();
      throw new Error('rollback failed');
    };
    conn.release = () => {
      released++;
      return realRelease();
    };
    return conn;
  };

  try {
    const res = await call('POST', '/contents/1/claim', { token: tokenFor(1), body: { impressionID: 1 } });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'internal_error');
  } finally {
    pool.getConnection = originalGetConnection;
    console.error = originalConsoleError;
  }

  const messages = logged.flat().map((item) => (item instanceof Error ? item.message : String(item)));
  assert.ok(messages.includes('boom'), `원래 에러(boom)가 로그에 있어야 한다: ${JSON.stringify(messages)}`);
  assert.equal(released, 1);
});

// ---- 이벤트 필수 contentID (리뷰 M-2) ----

test('contentID가 필요한 이벤트에 contentID가 없거나 잘못되면 400 invalid_event_type, 저장 0건', async () => {
  const bad = [
    { eventType: 'cooldown_view', payload: { ready: true, nextAvailableAt: null } },
    { eventType: 'content_enter' },
    { eventType: 'alarm_shown', payload: { channel: 'toast' } },
    { eventType: 'content_enter', contentID: '1' },
    { eventType: 'content_enter', contentID: 1.5 },
    { eventType: 'content_enter', contentID: 0 },
    { eventType: 'content_enter', contentID: 99999999999 },
  ];
  for (const event of bad) {
    const res = await postEvents(1, [{ eventType: 'home_enter' }, event]);
    assert.equal(res.status, 400, JSON.stringify(event));
    assert.equal(res.body.error, 'invalid_event_type');
  }
  assert.equal((await rows('SELECT * FROM event_log')).length, 0);
});

test('home_enter는 contentID가 필요 없고, 실려 와도 저장하지 않는다 (범위 오류로 500이 나지 않는다)', async () => {
  const res = await postEvents(1, [{ eventType: 'home_enter', contentID: 99999999999 }]);
  assert.equal(res.status, 200);
  const [event] = await rows('SELECT * FROM event_log');
  assert.equal(event.contentID, null);
});

// ---- GET /cooldowns (6-1, 5-2) ----

function getCooldowns(userID) {
  return call('GET', '/cooldowns', { token: tokenFor(userID) });
}

test('GET /cooldowns: 행이 없으면 모두 ready, nextAvailableAt은 null, 값은 문자열로 변환, 쓰기 없음', async () => {
  const res = await getCooldowns(1);
  assert.equal(res.status, 200);
  assert.ok(!Number.isNaN(Date.parse(res.body.serverTime)));
  assert.match(res.body.serverTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(res.body.contents, [
    // M7(7-5): 한도가 있는 콘텐츠는 dailyLimit와 remainingToday(행이 없으면 dailyLimit)를, 없으면 둘 다 null을 내려 준다.
    { contentID: 1, name: '낚시', ready: true, nextAvailableAt: null, rewardType: 'ticket', rewardAmount: 2, adFormat: 'install', dailyLimit: 10, remainingToday: 10 },
    { contentID: 2, name: '출석체크', ready: true, nextAvailableAt: null, rewardType: 'point', rewardAmount: 6, adFormat: 'video', dailyLimit: null, remainingToday: null },
    // M8: 방문 보너스(하루 3창, 설치형 광고, 한도 없음)가 seed에 들어왔다.
    { contentID: 3, name: '방문 보너스', ready: true, nextAvailableAt: null, rewardType: 'point', rewardAmount: 6, adFormat: 'install', dailyLimit: null, remainingToday: null },
  ]);
  // 조회는 읽기 전용이다: 행도, 이벤트도 만들지 않는다 (5-2).
  assert.equal((await rows('SELECT * FROM user_content_state')).length, 0);
  assert.equal((await rows('SELECT * FROM event_log')).length, 0);
});

test('GET /cooldowns: 쿨타임 중이면 ready=false와 저장된 시각, 지난 시각이면 ready=true와 null', async () => {
  await pool.query(
    `INSERT INTO user_content_state (userID, contentID, nextAvailableAt) VALUES
       (1, 1, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 45 MINUTE)),
       (1, 2, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE))`
  );
  const [stored] = await rows('SELECT nextAvailableAt FROM user_content_state WHERE userID = 1 AND contentID = 1');

  const res = await getCooldowns(1);
  const [fishing, attendance] = res.body.contents;
  assert.equal(fishing.ready, false);
  assert.equal(fishing.nextAvailableAt, stored.nextAvailableAt.toISOString());
  assert.ok(Date.parse(fishing.nextAvailableAt) > Date.parse(res.body.serverTime));
  assert.equal(attendance.ready, true); // 저장된 시각이 이미 지났다
  assert.equal(attendance.nextAvailableAt, null);
});

test('GET /cooldowns: 다른 유저의 상태는 보이지 않고, 토큰이 없으면 401', async () => {
  await pool.query(
    "INSERT INTO user_content_state (userID, contentID, nextAvailableAt) VALUES (1, 1, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 45 MINUTE))"
  );
  const other = await getCooldowns(2);
  assert.ok(other.body.contents.every((c) => c.ready === true));

  const anonymous = await call('GET', '/cooldowns');
  assert.equal(anonymous.status, 401);
});

// ---- claim 거절 경로의 로그 (5-3 1~2번) ----

// 1~2번에서 거절돼도 claim_rejected를 남기고 COMMIT한다. ROLLBACK하면 로그가 사라지므로,
// 거절 응답 뒤에 이벤트가 실제로 저장돼 있는지로 COMMIT을 확인한다.
const rejectionScenarios = [
  {
    reason: 'impression_not_found',
    status: 404,
    contentID: 1,
    prepare: async () => 123456,
  },
  {
    reason: 'content_mismatch',
    status: 400,
    contentID: 1,
    prepare: async () => completedImpression(1, 2),
  },
  {
    reason: 'ad_not_completed',
    status: 409,
    contentID: 1,
    prepare: async () => startImpression(1, 1),
  },
  {
    reason: 'impression_used',
    status: 409,
    contentID: 1,
    prepare: async () => {
      const impressionID = await completedImpression(1, 1);
      assert.equal((await claim(1, 1, impressionID)).status, 200);
      return impressionID;
    },
  },
  {
    reason: 'content_not_found',
    status: 404,
    contentID: 999,
    // 존재하지 않는 콘텐츠(999)에 대한 완료된 노출을 직접 만든다.
    prepare: async () => {
      const [inserted] = await pool.query(
        `INSERT INTO ad_impression (userID, contentID, adFormat, advertiser, startedAt, completedAt)
         VALUES (1, 999, 0, '테스트', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
      );
      return inserted.insertId;
    },
  },
];

for (const scenario of rejectionScenarios) {
  test(`claim 거절 ${scenario.reason}: ${scenario.status} 응답 뒤에 claim_rejected 로그가 저장되어 있다`, async () => {
    const impressionID = await scenario.prepare();
    const res = await claim(1, scenario.contentID, impressionID);
    assert.equal(res.status, scenario.status);
    assert.deepEqual(res.body, { error: scenario.reason });

    const events = await rows("SELECT * FROM event_log WHERE eventType = 'claim_rejected'");
    assert.equal(events.length, 1);
    assert.equal(events[0].contentID, scenario.contentID);
    assert.equal(events[0].payload.reason, scenario.reason);
    // 거절한 요청은 보상도 쿨타임도 만들지 않는다. (impression_used 시나리오의 보상 1건은 준비 단계의 첫 적립이다.)
    const expectedRewards = scenario.reason === 'impression_used' ? 1 : 0;
    assert.equal((await rows('SELECT * FROM reward')).length, expectedRewards);
  });
}

// ---- 광고 완료 동시 호출 (6-3) ----

test('같은 노출의 광고 완료를 동시에 두 번 불러도 둘 다 200이고 ad_complete 이벤트는 한 번', async () => {
  const impressionID = await startImpression(1, 1);
  const path = `/ads/impressions/${impressionID}/complete`;
  const results = await Promise.all(Array.from({ length: 5 }, () => call('POST', path, { token: tokenFor(1) })));
  assert.ok(results.every((r) => r.status === 200 && r.body.completed === true));
  assert.equal((await rows("SELECT * FROM event_log WHERE eventType = 'ad_complete'")).length, 1);
  const [imp] = await rows('SELECT * FROM ad_impression WHERE impressionID = ?', [impressionID]);
  assert.notEqual(imp.completedAt, null);
});

// ---- 하루 한도 (M7, 7-4 ~ 7-5) ----
// 한도를 바꾸려고 seed의 콘텐츠(1, 2, 3번)를 건드리지 않는다. 테스트마다 임시 콘텐츠(TEST_CONTENT_ID_BASE + n)를 만들고 끝에 반드시 지운다.
// (metrics 테스트의 funnel 콘텐츠 목록과 GET /cooldowns 테스트를 흔들지 않기 위해서다.)

async function withTestContent(contentID, dailyLimit, run) {
  await pool.query(
    `INSERT INTO content (contentID, name, cooldownType, intervalSec, resetTimesKST, adFormat, rewardType, rewardAmount, dailyLimit)
     VALUES (?, ?, 0, 3600, NULL, 1, 1, 2, ?)`,
    [contentID, TEST_CONTENT_NAME, dailyLimit]
  );
  try {
    await run();
  } finally {
    await pool.query('DELETE FROM content WHERE contentID = ? AND name = ?', [contentID, TEST_CONTENT_NAME]);
  }
}

// 쿨타임만 지난 상태로 되돌린다. 그러면 막는 것은 하루 한도뿐이다.
function rewindCooldown(userID, contentID) {
  return pool.query(
    "UPDATE user_content_state SET nextAvailableAt = '2000-01-01 00:00:00.000' WHERE userID = ? AND contentID = ?",
    [userID, contentID]
  );
}

async function dbNow() {
  const [[{ now }]] = await pool.query('SELECT UTC_TIMESTAMP(3) AS now');
  return now;
}

async function stateOf(userID, contentID) {
  const [state] = await rows('SELECT * FROM user_content_state WHERE userID = ? AND contentID = ?', [userID, contentID]);
  return state;
}

test('A13 한도 2: 세 번째 claim은 409 daily_limit_reached (다음 한국 00:00, 노출 소진, 거절 로그)', async () => {
  await withTestContent(900000001, 2, async () => {
    for (let i = 0; i < 2; i++) {
      const res = await claim(1, 900000001, await completedImpression(1, 900000001));
      assert.equal(res.status, 200, `${i + 1}번째`);
      await rewindCooldown(1, 900000001);
    }

    const third = await completedImpression(1, 900000001);
    const res = await claim(1, 900000001, third);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'daily_limit_reached');
    assert.equal(res.body.nextAvailableAt, nextKstMidnight(await dbNow()).toISOString());

    assert.equal((await rows('SELECT * FROM reward WHERE contentID = 900000001')).length, 2);
    assert.equal((await stateOf(1, 900000001)).todayCount, 2);
    const [imp] = await rows('SELECT * FROM ad_impression WHERE impressionID = ?', [third]);
    assert.equal(imp.used, 1); // 보고 나서 거절된 노출은 소진
    const [rejected] = await rows("SELECT * FROM event_log WHERE eventType = 'claim_rejected'");
    assert.equal(rejected.contentID, 900000001);
    assert.equal(rejected.payload.reason, 'daily_limit_reached');
    assert.equal(rejected.payload.nextAvailableAt, res.body.nextAvailableAt);
  });
});

test('A14 한도 1에서 서로 다른 노출 20개로 동시 claim: 200 정확히 1건, 나머지 19건은 모두 cooldown_active', async () => {
  await withTestContent(900000002, 1, async () => {
    const impressionIDs = await Promise.all(Array.from({ length: 20 }, () => completedImpression(1, 900000002)));
    const results = await Promise.all(impressionIDs.map((id) => claim(1, 900000002, id)));

    const ok = results.filter((r) => r.status === 200);
    assert.equal(ok.length, 1);
    assert.equal(results.filter((r) => r.status >= 500).length, 0);
    // 진 요청은 이긴 요청이 저장한 쿨타임(미래) 때문에 거절된다. daily_limit_reached가 섞이면 7번의 읽기가
    // 최신 값이 아니라 옛 스냅샷(FOR SHARE 누락)을 보고 원인을 잘못 분류한 것이다.
    const rejected = results.filter((r) => r.status !== 200);
    assert.equal(rejected.length, 19);
    for (const r of rejected) {
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'cooldown_active');
      assert.equal(r.body.nextAvailableAt, ok[0].body.nextAvailableAt);
    }

    assert.equal((await rows('SELECT * FROM reward WHERE contentID = 900000002')).length, 1);
    assert.equal((await stateOf(1, 900000002)).todayCount, 1);
    assert.equal((await rows("SELECT * FROM event_log WHERE eventType = 'claim_ok'")).length, 1);
    const logged = await rows("SELECT * FROM event_log WHERE eventType = 'claim_rejected'");
    assert.equal(logged.length, 19);
    assert.ok(logged.every((e) => e.payload.reason === 'cooldown_active'));
  });
});

test('A15 한도가 찬 뒤 날짜가 바뀌면 다시 200이고 todayCount는 1부터 다시 센다', async () => {
  await withTestContent(900000003, 1, async () => {
    assert.equal((await claim(1, 900000003, await completedImpression(1, 900000003))).status, 200);
    await rewindCooldown(1, 900000003);
    const blocked = await claim(1, 900000003, await completedImpression(1, 900000003));
    assert.equal(blocked.body.error, 'daily_limit_reached'); // 같은 날이면 막힌다

    // 카운터가 센 날을 어제로 되돌린다 = 날짜가 바뀐 상황
    const today = kstDayStart(await dbNow());
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
    await pool.query('UPDATE user_content_state SET countDayStart = ? WHERE userID = 1 AND contentID = 900000003', [yesterday]);

    const res = await claim(1, 900000003, await completedImpression(1, 900000003));
    assert.equal(res.status, 200);
    const state = await stateOf(1, 900000003);
    assert.equal(state.todayCount, 1);
    assert.equal(state.countDayStart.getTime(), today.getTime());
  });
});

test('한도가 없는 콘텐츠(dailyLimit NULL)는 몇 번을 적립해도 막히지 않는다', async () => {
  await withTestContent(900000005, null, async () => {
    for (let i = 0; i < 4; i++) {
      assert.equal((await claim(1, 900000005, await completedImpression(1, 900000005))).status, 200, `${i + 1}번째`);
      await rewindCooldown(1, 900000005);
    }
    assert.equal((await stateOf(1, 900000005)).todayCount, 4);
  });
});

test('A16 GET /cooldowns: 한도가 찬 콘텐츠는 ready=false, nextAvailableAt은 다음 한국 00:00, 조회는 행을 만들지 않는다', async () => {
  await withTestContent(900000004, 1, async () => {
    const find = (res) => res.body.contents.find((c) => c.contentID === 900000004);

    const before = await getCooldowns(1);
    assert.equal(find(before).ready, true);
    assert.equal(find(before).remainingToday, 1); // 행이 없으면 dailyLimit

    assert.equal((await claim(1, 900000004, await completedImpression(1, 900000004))).status, 200);
    await rewindCooldown(1, 900000004); // 쿨타임은 지났고, 막는 것은 한도뿐이다
    const countBefore = (await rows('SELECT * FROM user_content_state')).length;

    const full = await getCooldowns(1);
    const midnight = nextKstMidnight(new Date(full.body.serverTime)).toISOString();
    assert.equal(find(full).dailyLimit, 1);
    assert.equal(find(full).remainingToday, 0);
    assert.equal(find(full).ready, false);
    assert.equal(find(full).nextAvailableAt, midnight);
    assert.equal((await rows('SELECT * FROM user_content_state')).length, countBefore); // 읽기 전용

    // 저장된 쿨타임이 자정보다 늦으면(자정 직전 적립) 그 값을 그대로 쓴다 = max(저장된 값, 다음 한국 00:00)
    const later = new Date(Date.parse(midnight) + 30 * 60 * 1000);
    await pool.query('UPDATE user_content_state SET nextAvailableAt = ? WHERE userID = 1 AND contentID = 900000004', [later]);
    assert.equal(find(await getCooldowns(1)).nextAvailableAt, later.toISOString());

    // 날짜가 바뀌면 다시 한도가 남은 것으로 보인다
    const yesterday = new Date(kstDayStart(new Date(full.body.serverTime)).getTime() - 24 * 3600 * 1000);
    await pool.query(
      "UPDATE user_content_state SET countDayStart = ?, nextAvailableAt = '2000-01-01 00:00:00.000' WHERE userID = 1 AND contentID = 900000004",
      [yesterday]
    );
    const nextDay = find(await getCooldowns(1));
    assert.equal(nextDay.remainingToday, 1);
    assert.equal(nextDay.ready, true);
    assert.equal(nextDay.nextAvailableAt, null);
  });
});

// ---- 방문 보너스 (M8) ----

test('seed: 방문 보너스는 하루 3창(한국 00:00·08:00·16:00), 포인트 6, 설치형 광고, 한도 없음', async () => {
  const [bonus] = await rows('SELECT * FROM content WHERE contentID = 3');
  assert.equal(bonus.name, '방문 보너스');
  assert.equal(bonus.cooldownType, 1); // dailyReset
  assert.deepEqual(bonus.resetTimesKST, ['00:00', '08:00', '16:00']);
  assert.equal(bonus.adFormat, 1); // install (광고를 누르면 앱스토어로 이동하는 방식)
  assert.equal(bonus.rewardType, 0); // point
  assert.equal(bonus.rewardAmount, 6);
  assert.equal(bonus.dailyLimit, null); // 하루 3번은 초기화 시각이 이미 보장한다
});

test('방문 보너스 적립: 다음 가능 시각은 한국 00:00·08:00·16:00 중 다음 것이고, 같은 창에서는 다시 못 받는다', async () => {
  const res = await claim(1, 3, await completedImpression(1, 3));
  assert.equal(res.status, 200);
  assert.equal(res.body.rewardType, 'point');
  assert.equal(res.body.amount, 6);

  const [content] = await rows('SELECT * FROM content WHERE contentID = 3');
  const state = await stateOf(1, 3);
  assert.equal(res.body.nextAvailableAt, computeNextAvailableAt(content, state.lastRewardAt).toISOString());
  // 시각 자체도 세 창의 경계 중 하나여야 한다 (한국 시간 = UTC + 9시간)
  const kst = new Date(Date.parse(res.body.nextAvailableAt) + 9 * 3600 * 1000);
  const hhmm = kst.toISOString().slice(11, 16);
  assert.ok(['00:00', '08:00', '16:00'].includes(hhmm), `다음 가능 시각 ${hhmm}`);

  const again = await claim(1, 3, await completedImpression(1, 3));
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'cooldown_active');
});

// ---- 테스트용 콘텐츠 정리의 안전 (리뷰: 개발 DB의 실제 콘텐츠를 지우지 않는다) ----

test('테스트용 콘텐츠 정리는 "테스트 전용 ID 범위"와 "이름 표식"이 모두 맞는 행만 지운다', async () => {
  const insert = (contentID, name) =>
    pool.query(
      'INSERT INTO content (contentID, name, cooldownType, intervalSec, resetTimesKST, adFormat, rewardType, rewardAmount, dailyLimit) VALUES (?, ?, 0, 3600, NULL, 1, 1, 2, NULL)',
      [contentID, name]
    );
  await insert(100, '직접 만든 콘텐츠'); // 개발 DB에 직접 만들어 둔 실제 콘텐츠. 지우면 안 된다
  await insert(TEST_CONTENT_ID_BASE + 500, '큰 ID지만 실제 콘텐츠'); // 범위 안이어도 이름 표식이 없으면 지우면 안 된다
  await insert(TEST_CONTENT_ID_BASE + 501, TEST_CONTENT_NAME); // 테스트가 만든 행: 지워야 한다
  try {
    await cleanupTestContent();
    const left = (await rows('SELECT contentID FROM content ORDER BY contentID')).map((r) => r.contentID);
    assert.ok(left.includes(100), '100번(직접 만든 콘텐츠)이 사라졌다');
    assert.ok(left.includes(TEST_CONTENT_ID_BASE + 500), '이름 표식이 없는 행이 사라졌다');
    assert.ok(!left.includes(TEST_CONTENT_ID_BASE + 501), '테스트가 만든 행이 남았다');
    assert.deepEqual(left.filter((id) => id < 100), [1, 2, 3]); // seed는 그대로
  } finally {
    await pool.query('DELETE FROM content WHERE contentID IN (100, ?)', [TEST_CONTENT_ID_BASE + 500]);
    await cleanupTestContent();
  }
});
