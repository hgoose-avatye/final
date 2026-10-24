// POST /contents/:id/claim (6-4). 5-3의 적립 관문. 단계 번호는 REQUIREMENTS.md 5-3과 같다.
//
// 이 파일에서 가장 중요한 것: "쿨타임 중이 아닐 때만 갱신한다"를 읽고 나서 쓰는 방식이 아니라
// 6번의 조건부 UPDATE 한 문장으로 한다. 읽고 쓰면 동시 요청 100개가 모두 "가능"을 읽고 100번 적립된다.
// 조건부 UPDATE는 행 락 때문에 한 요청만 affectedRows = 1을 받는다.
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');
const { computeNextAvailableAt } = require('../cooldown');

const REWARD_TYPE = ['point', 'ticket'];

async function claim(userID, contentID, impressionID) {
  // 5. (BEGIN 앞, 자동 커밋) 첫 적립이면 상태 행을 만든다.
  // 이유: 6번의 UPDATE는 행이 있어야 걸린다. 트랜잭션 안에서 만들면 동시 요청들이 서로 공유 락을 쥔 채
  // 6번의 배타 락을 기다려 데드락이 난다. 그래서 트랜잭션 밖에서 먼저 한다. (이미 있으면 IGNORE로 아무 일도 안 한다.)
  await pool.query('INSERT IGNORE INTO user_content_state (userID, contentID) VALUES (?, ?)', [userID, contentID]);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await claimInTransaction(conn, userID, contentID, impressionID);
    // 거절도 COMMIT한다. ROLLBACK하면 거절 로그와 노출 소진(used=1)도 같이 사라진다 (5-3).
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function claimInTransaction(conn, userID, contentID, impressionID) {
  // 1. 노출을 잠그고 읽는다 (FOR UPDATE).
  // 이유: 같은 노출로 동시에 claim이 와도 여기서 줄을 세워, 뒤 요청은 앞 요청이 끝난 뒤의 used 값을 본다 (A4).
  // userID 조건: 남의 노출은 "없음"으로 보여서 404로 같은 응답을 준다 (존재 여부를 알려 주지 않는다, A6).
  const [imps] = await conn.query(
    'SELECT * FROM ad_impression WHERE impressionID = ? AND userID = ? FOR UPDATE',
    [impressionID, userID]
  );
  if (imps.length === 0) {
    return reject(conn, userID, contentID, 404, 'impression_not_found');
  }
  const imp = imps[0];
  if (imp.contentID !== contentID) {
    return reject(conn, userID, contentID, 400, 'content_mismatch');
  }
  if (imp.completedAt === null) {
    // 광고를 끝까지 보지 않았다. 노출을 소진하지 않는다 (아직 볼 수 있다).
    return reject(conn, userID, contentID, 409, 'ad_not_completed');
  }
  if (imp.used === 1) {
    return reject(conn, userID, contentID, 409, 'impression_used');
  }

  // 2. 보상량과 쿨타임 규칙은 항상 content 설정에서만 가져온다. 요청 본문의 값은 받지도 믿지도 않는다 (9-3).
  const [contents] = await conn.query('SELECT * FROM content WHERE contentID = ?', [contentID]);
  if (contents.length === 0) {
    return reject(conn, userID, contentID, 404, 'content_not_found');
  }
  const content = contents[0];

  // 3. 현재 시각은 DB 시각을 한 번만 읽는다. 앱 서버의 Date.now()는 쓰지 않는다 (3장).
  // 이유: 이 now 하나를 아래 모든 곳(lastRewardAt, nextAvailableAt, 6번 조건, createdAt, 이벤트)에 써야
  // 문장마다 시각이 어긋나서 생기는 경계 오판정이 없다.
  const [[{ now }]] = await conn.query('SELECT UTC_TIMESTAMP(3) AS now');

  // 4. 다음 가능 시각은 DB도 시계도 읽지 않는 순수 함수로 계산한다 (cooldown.js).
  const next = computeNextAvailableAt(content, now);

  // 6. 조건부 UPDATE: nextAvailableAt <= now 인 행만 갱신한다. 이것이 중복 적립을 막는 핵심이다.
  // 동시 요청 중 먼저 락을 잡은 하나만 조건을 만족하고, 나머지는 그 요청의 커밋 뒤에 (이미 미래가 된) 값을 보고 0행이 된다.
  const [updated] = await conn.query(
    `UPDATE user_content_state
        SET lastRewardAt = ?, nextAvailableAt = ?
      WHERE userID = ? AND contentID = ? AND nextAvailableAt <= ?`,
    [now, next, userID, contentID, now]
  );

  // 7. 0행이면 쿨타임 중이다.
  if (updated.affectedRows === 0) {
    // 보고 나서 거절된 노출은 소진시킨다. 안 그러면 거절된 노출을 쿨타임이 끝난 뒤 다시 쓸 수 있다.
    await conn.query('UPDATE ad_impression SET used = 1 WHERE impressionID = ?', [impressionID]);

    // 현재 저장된 값을 읽는다. 일반 SELECT가 아니라 FOR SHARE를 쓰는 이유:
    // 이 트랜잭션은 2번의 일반 SELECT에서 스냅샷을 잡았기 때문에, 일반 SELECT는 다른 요청이 커밋하기 전의
    // 옛 값(1970)을 돌려줄 수 있다. 잠금 읽기는 항상 최신 커밋 값을 읽는다.
    const [[state]] = await conn.query(
      'SELECT nextAvailableAt FROM user_content_state WHERE userID = ? AND contentID = ? FOR SHARE',
      [userID, contentID]
    );
    const nextAvailableAt = state.nextAvailableAt.toISOString();
    await insertEvent(conn, userID, 'claim_rejected', contentID, now, { reason: 'cooldown_active', nextAvailableAt });
    return { status: 409, body: { error: 'cooldown_active', nextAvailableAt } };
  }

  // 8. 보상 기록. reward.impressionID의 UNIQUE가 같은 노출로 두 번 적립되는 것을 DB 차원에서 마지막으로 막는다.
  const [rewardInserted] = await conn.query(
    `INSERT INTO reward (userID, contentID, rewardType, amount, impressionID, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userID, contentID, content.rewardType, content.rewardAmount, impressionID, now]
  );

  // 9. 노출 소진.
  await conn.query('UPDATE ad_impression SET used = 1 WHERE impressionID = ?', [impressionID]);

  // 10. 성공 로그. 동작과 같은 트랜잭션 안에서 남겨야 "적립은 됐는데 로그가 없는" 일이 없다 (8장).
  const rewardID = rewardInserted.insertId;
  const nextAvailableAt = next.toISOString();
  await insertEvent(conn, userID, 'claim_ok', contentID, now, {
    rewardID,
    amount: content.rewardAmount,
    nextAvailableAt,
  });

  return {
    status: 200,
    body: {
      rewardID,
      rewardType: REWARD_TYPE[content.rewardType],
      amount: content.rewardAmount,
      nextAvailableAt,
    },
  };
}

// 1~2번의 거절: claim_rejected를 남기고 응답을 돌려준다 (호출한 쪽이 COMMIT한다).
// 이유: 거절도 지표(8장)와 추적(FR-9)에 필요하다. 이 시점에는 아직 3번의 now가 없어서 시각을 따로 읽는다.
async function reject(conn, userID, contentID, status, reason) {
  const [[{ now }]] = await conn.query('SELECT UTC_TIMESTAMP(3) AS now');
  await insertEvent(conn, userID, 'claim_rejected', contentID, now, { reason });
  return { status, body: { error: reason } };
}

async function insertEvent(conn, userID, eventType, contentID, occurredAt, payload) {
  await conn.query(
    `INSERT INTO event_log (userID, eventType, contentID, occurredAt, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [userID, eventType, contentID, occurredAt, JSON.stringify(payload)]
  );
}

const router = express.Router();

// contentID는 DB의 INT, impressionID는 BIGINT다. 범위를 벗어난 값은 DB에 보내지 않는다.
// 이유: 5번의 INSERT IGNORE가 범위 밖 값을 최댓값으로 잘라 쓰레기 행을 만들고, 이벤트 INSERT는 범위 오류(500)가 난다.
const MAX_INT = 2147483647;

router.post('/contents/:id/claim', requireUser, async (req, res, next) => {
  try {
    const impressionID = req.body && req.body.impressionID;
    // 올바르지 않은 id는 6-4에 정의된 기존 에러 코드로 거절한다 (새 코드를 만들지 않는다).
    const contentID = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!Number.isInteger(contentID) || contentID < 1 || contentID > MAX_INT) {
      return res.status(404).json({ error: 'content_not_found' });
    }
    if (!Number.isSafeInteger(impressionID) || impressionID < 1) {
      return res.status(404).json({ error: 'impression_not_found' });
    }
    const { status, body } = await claim(req.userID, contentID, impressionID);
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
