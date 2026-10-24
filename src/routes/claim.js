// POST /contents/:id/claim (6-4). 5-3의 적립 관문. 단계 번호는 REQUIREMENTS.md 5-3과 같다.
//
// 이 파일에서 가장 중요한 것: "쿨타임이 끝났고 오늘 한도가 남았을 때만 갱신한다"를 읽고 나서 쓰는 방식이 아니라
// 6번의 조건부 UPDATE 한 문장으로 한다. 읽고 쓰면 동시 요청 100개가 모두 "가능"을 읽고 100번 적립된다.
// 조건부 UPDATE는 행 락 때문에 한 요청만 affectedRows = 1을 받는다.
//
// 격리 수준(InnoDB 기본값 REPEATABLE READ)과 FOR SHARE는 짝으로 이해해야 한다.
// - 일반 SELECT는 트랜잭션 안에서 처음 읽은 시점의 스냅샷을 계속 본다 (그 뒤에 다른 요청이 커밋한 값은 안 보인다).
// - UPDATE, FOR UPDATE, FOR SHARE는 항상 "가장 최신에 커밋된 값"을 읽는다.
// 그래서 6번은 다른 요청이 방금 커밋한 값을 보고 정확히 판단하지만, 7번에서 "지금 저장된 값"을 읽어 응답에 담고
// 쿨타임 때문인지 한도 때문인지 가를 때 일반 SELECT를 쓰면 스냅샷의 옛 값(1970)이 나온다. 7번이 FOR SHARE를 쓰는 이유다. 격리 수준 자체는 바꾸지 않는다.
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');
const { computeNextAvailableAt, kstDayStart, nextKstMidnight, remainingTodayOf, limitAwareNextAvailableAt } = require('../cooldown');

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
    // rollback 자체가 실패해도(연결이 끊긴 경우 등) 던지는 것은 원래 에러다. 안 그러면 진짜 원인이 가려진다.
    await conn.rollback().catch((rollbackErr) => console.error('rollback 실패', rollbackErr));
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
  // 검사 순서는 5-3 그대로다. 두 검사가 겹치지 않아서 순서가 결과를 바꾸지는 않는다:
  // 노출은 적립이나 7번의 거절(쿨타임, 한도)로만 소진(used=1)되는데, 모두 광고를 완료한 노출만 거기까지 온다.
  // 그래서 used=1인 노출은 항상 완료된 노출이고, 완료되지 않은 노출은 항상 used=0이다.
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
  // 하루 한도(M7)의 "오늘": 이 now가 속한 한국 날짜의 00:00(UTC). 카운터가 어느 날 센 값인지 구분하는 기준이다.
  const dayStart = kstDayStart(now);

  // 6. 조건부 UPDATE: nextAvailableAt <= now 이고 하루 한도가 남은 행만 갱신한다. 이것이 중복 적립을 막는 핵심이다.
  // 동시 요청 중 먼저 락을 잡은 하나만 조건을 만족하고, 나머지는 그 요청의 커밋 뒤에 (이미 미래가 된) 값을 보고 0행이 된다.
  //
  // 한도(M7)도 같은 문장의 WHERE에 넣었다. 관문이 하나로 유지되어, 한도를 따로 COUNT로 세는 방식에서 생기는
  // "세는 시점과 쓰는 시점 사이의 틈"이 없다. 한도가 없으면(NULL) 또는 새 날이면(countDayStart가 다르거나 처음) 통과한다.
  //
  // SET의 순서가 중요하다: MySQL은 SET을 왼쪽부터 평가한다. todayCount를 countDayStart보다 앞에 써야
  // todayCount가 "갱신 전의" countDayStart와 비교한다. 순서를 바꾸면 새 날에도 카운터가 1로 돌아가지 않는다.
  const [updated] = await conn.query(
    `UPDATE user_content_state
        SET lastRewardAt = ?, nextAvailableAt = ?,
            todayCount = IF(countDayStart = ?, todayCount + 1, 1),
            countDayStart = ?
      WHERE userID = ? AND contentID = ? AND nextAvailableAt <= ?
        AND (? IS NULL OR countDayStart IS NULL OR countDayStart <> ? OR todayCount < ?)`,
    [now, next, dayStart, dayStart, userID, contentID, now, content.dailyLimit, dayStart, content.dailyLimit]
  );

  // 7. 0행이면 거절이다. 쿨타임 중이거나 하루 한도가 찼다.
  if (updated.affectedRows === 0) {
    // 보고 나서 거절된 노출은 소진시킨다. 안 그러면 거절된 노출을 쿨타임이 끝난 뒤 다시 쓸 수 있다.
    await conn.query('UPDATE ad_impression SET used = 1 WHERE impressionID = ?', [impressionID]);

    // 현재 저장된 값을 읽는다. 일반 SELECT가 아니라 FOR SHARE를 쓰는 이유:
    // 이 트랜잭션은 2번의 일반 SELECT에서 스냅샷을 잡았기 때문에, 일반 SELECT는 다른 요청이 커밋하기 전의
    // 옛 값(1970)을 돌려줄 수 있다. 잠금 읽기는 항상 최신 커밋 값을 읽는다.
    // M7에서는 이 값으로 "쿨타임 때문인지 한도 때문인지"도 가른다. 옛 값을 보면 쿨타임 중인 요청이
    // 한도 때문에 거절된 것으로 잘못 분류된다 (A14가 이 경우를 잡는다).
    const [[state]] = await conn.query(
      'SELECT nextAvailableAt, todayCount, countDayStart FROM user_content_state WHERE userID = ? AND contentID = ? FOR SHARE',
      [userID, contentID]
    );

    // 쿨타임이 아직 남아 있으면 쿨타임이 먼저다. 이 응답은 "언제 다시 시도할 수 있는지"를 알려 준다.
    if (state.nextAvailableAt.getTime() > now.getTime()) {
      // 한도도 찼다면 GET /cooldowns와 같은 시각을 알려 준다 (6-2와 같은 공유 계산). 안 그러면 응답은 "쿨타임이 끝나는 시각"을
      // 말하는데 그때 다시 시도하면 daily_limit_reached가 나온다. 한도가 남았거나 없으면 저장된 쿨타임 그대로다.
      const remaining = remainingTodayOf({ dailyLimit: content.dailyLimit, ...state }, now);
      const nextAvailableAt = limitAwareNextAvailableAt(state.nextAvailableAt, remaining, now).toISOString();
      await insertEvent(conn, userID, 'claim_rejected', contentID, now, { reason: 'cooldown_active', nextAvailableAt });
      return { status: 409, body: { error: 'cooldown_active', nextAvailableAt } };
    }

    // 쿨타임은 지났는데 0행이었다면 남은 원인은 하루 한도뿐이다. 다시 할 수 있는 때는 다음 한국 00:00이다.
    const nextAvailableAt = nextKstMidnight(now).toISOString();
    await insertEvent(conn, userID, 'claim_rejected', contentID, now, { reason: 'daily_limit_reached', nextAvailableAt });
    return { status: 409, body: { error: 'daily_limit_reached', nextAvailableAt } };
  }

  // 6-2. 방금 갱신한 내 행의 카운터를 읽어, 응답과 로그에 담을 "다시 할 수 있는 시각"에 하루 한도를 반영한다.
  // 이유: 이 적립이 오늘의 마지막(한도가 찼다)이면 쿨타임이 끝나도 다음 한국 00:00까지는 못 한다. 응답이 쿨타임 시각만 말하면
  // GET /cooldowns(홈)가 말하는 시각과 어긋나고, 결과 화면이 "다음은 1시간 뒤부터"라고 틀리게 안내한다.
  // GET과 같은 계산(cooldown.js의 공유 함수)을 쓴다. 같은 트랜잭션이라 방금 쓴 값이 보이고, 일반 SELECT라 락을 더하지 않는다.
  // (7번과 달리 여기서는 잠금 읽기가 필요 없다. 읽는 것이 다른 요청의 커밋이 아니라 우리가 방금 쓴 행이기 때문이다.)
  // DB에 저장하는 값(nextAvailableAt)은 쿨타임 그대로다. 한도는 읽을 때와 응답할 때만 반영한다.
  const [[counter]] = await conn.query(
    'SELECT todayCount, countDayStart FROM user_content_state WHERE userID = ? AND contentID = ?',
    [userID, contentID]
  );
  const remainingToday = remainingTodayOf({ dailyLimit: content.dailyLimit, ...counter }, now);
  const shownNextAvailableAt = limitAwareNextAvailableAt(next, remainingToday, now);

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
  // 응답과 claim_ok의 nextAvailableAt은 같은 값이다 (6-2). 지표의 재진입 지연이 이 값을 기준으로 쓰므로,
  // 한도가 찬 유저는 "쿨타임이 끝난 시각"이 아니라 "실제로 다시 할 수 있게 된 시각"부터 돌아온 시간을 잰다.
  const nextAvailableAt = shownNextAvailableAt.toISOString();
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
