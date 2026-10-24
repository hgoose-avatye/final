// 시연 리셋(scripts/demo-reset.js) 테스트. Docker MySQL이 떠 있어야 한다.
// 실제 시연 유저(1)는 건드리지 않고 테스트 전용 유저로 확인한다. 이 테스트는 그 유저의 행만 지운다.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const pool = require('../src/db');
const { computeNextAvailableAt } = require('../src/cooldown');
const { resetDemo } = require('../scripts/demo-reset');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'demo-reset.js');
const TEST_USER = 900001; // 시연 유저(1)와 겹치지 않는 값

async function clearTestUser() {
  for (const table of ['user_content_state', 'event_log', 'reward', 'ad_impression']) {
    await pool.query(`DELETE FROM ${table} WHERE userID = ?`, [TEST_USER]);
  }
}

before(clearTestUser);
after(async () => {
  try {
    await clearTestUser();
  } finally {
    await pool.end(); // 안 닫으면 테스트 프로세스가 끝나지 않는다
  }
});
beforeEach(clearTestUser);

async function stateOf(contentID) {
  const [rows] = await pool.query(
    `SELECT lastRewardAt, nextAvailableAt, todayCount, countDayStart,
            TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), nextAvailableAt) / 1000000 AS secondsFromNow,
            TIMESTAMPDIFF(MICROSECOND, lastRewardAt, UTC_TIMESTAMP(3)) / 1000000 AS secondsSinceReward
       FROM user_content_state WHERE userID = ? AND contentID = ?`,
    [TEST_USER, contentID],
  );
  return rows[0];
}

test('낚시는 지금 + N초 뒤에 가능하고 오늘 횟수는 0으로 돌아간다 (기본 90초, 인자로 변경)', async () => {
  // 한도가 찼던 상태에서 시작해도 되돌아간다
  await pool.query(
    `INSERT INTO user_content_state (userID, contentID, nextAvailableAt, todayCount, countDayStart)
     VALUES (?, 1, '2099-01-01 00:00:00.000', 10, UTC_TIMESTAMP(3))`,
    [TEST_USER],
  );
  await resetDemo(TEST_USER, 90);
  let state = await stateOf(1);
  assert.ok(state.secondsFromNow > 87 && state.secondsFromNow <= 90, `90초 뒤여야 한다: ${state.secondsFromNow}`);
  assert.equal(state.todayCount, 0);

  await resetDemo(TEST_USER, 30);
  state = await stateOf(1);
  assert.ok(state.secondsFromNow > 27 && state.secondsFromNow <= 30, `30초 뒤여야 한다: ${state.secondsFromNow}`);
});

test('방문 보너스는 방금 적립한 상태: lastRewardAt이 지금이고 nextAvailableAt은 computeNextAvailableAt의 다음 초기화 시각', async () => {
  await resetDemo(TEST_USER, 90);
  const state = await stateOf(3);
  assert.ok(state.secondsSinceReward >= 0 && state.secondsSinceReward < 10, `방금이어야 한다: ${state.secondsSinceReward}`);
  const [[bonus]] = await pool.query('SELECT * FROM content WHERE contentID = 3');
  const expected = computeNextAvailableAt(bonus, state.lastRewardAt); // 적립한 그 시각을 기준으로 계산한 값
  assert.equal(state.nextAvailableAt.toISOString(), expected.toISOString());
  assert.ok(state.secondsFromNow > 0, '다음 초기화 시각은 미래다');
});

test('출석체크는 가능 상태: 쿨타임 중이던 행이 지워진다', async () => {
  await pool.query(
    `INSERT INTO user_content_state (userID, contentID, lastRewardAt, nextAvailableAt)
     VALUES (?, 2, UTC_TIMESTAMP(3), '2099-01-01 00:00:00.000')`,
    [TEST_USER],
  );
  await resetDemo(TEST_USER, 90);
  assert.equal(await stateOf(2), undefined);
});

test('user_content_state만 바꾼다: 다른 유저의 행, event_log, reward, ad_impression은 그대로', async () => {
  await pool.query(`INSERT INTO event_log (userID, eventType, contentID, occurredAt) VALUES (?, 'home_enter', NULL, UTC_TIMESTAMP(3))`, [TEST_USER]);
  await pool.query(`INSERT INTO ad_impression (userID, contentID, adFormat, advertiser, startedAt, completedAt, used) VALUES (?, 2, 0, '모의', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 1)`, [TEST_USER]);
  const [[{ id: impressionID }]] = await pool.query('SELECT MAX(impressionID) AS id FROM ad_impression WHERE userID = ?', [TEST_USER]);
  await pool.query(`INSERT INTO reward (userID, contentID, rewardType, amount, impressionID, createdAt) VALUES (?, 2, 0, 6, ?, UTC_TIMESTAMP(3))`, [TEST_USER, impressionID]);

  await resetDemo(TEST_USER, 90);

  for (const table of ['event_log', 'reward', 'ad_impression']) {
    const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE userID = ?`, [TEST_USER]);
    assert.equal(n, 1, `${table}의 행이 남아 있어야 한다`);
  }
  const [[{ others }]] = await pool.query('SELECT COUNT(*) AS others FROM user_content_state WHERE userID = ?', [TEST_USER + 1]);
  assert.equal(others, 0); // 다른 유저(여기서는 TEST_USER + 1)의 행을 만들지 않았다
});

test('resetDemo는 한 줄 요약을 돌려준다', async () => {
  const line = await resetDemo(TEST_USER, 45);
  assert.match(line, /userID=900001/);
  assert.match(line, /튜브 낚시 45초 뒤 가능/);
  assert.match(line, /방문 보너스 방금 적립/);
  assert.match(line, /출석체크 참여 가능/);
});

// ---- 실행 환경 검사: 자식 프로세스에서 실행한다. DB에는 접속하지 않고 그 전에 끝난다. ----

function runScript(args, env) {
  const merged = { ...process.env, ...env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete merged[name];
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: merged, encoding: 'utf8' });
}

test('NODE_ENV가 development가 아니면 실행하지 않고 이유를 알려 준다 (production, 값 없음)', () => {
  for (const nodeEnv of ['production', undefined]) {
    const result = runScript([], { NODE_ENV: nodeEnv });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NODE_ENV/);
  }
});

test('초 인자가 양의 정수가 아니면 실행하지 않는다', () => {
  for (const bad of ['abc', '0', '-5', '1.5']) {
    const result = runScript([bad], { NODE_ENV: 'development' });
    assert.notEqual(result.status, 0, `인자 ${bad}`);
    assert.match(result.stderr, /초/);
  }
});
