// 모의 광고 시작(6-2)과 완료(6-3). 쿨타임은 여기서 검사하지 않는다. 최종 판단은 claim이 한다.
// 노출 행과 이벤트 로그는 한 트랜잭션으로 묶는다: 동작과 로그가 같이 성공하거나 같이 실패해야 한다 (8장).
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');
const { pickAd } = require('../ads');

const AD_FORMAT = ['video', 'install'];

function adSeconds() {
  return Number(process.env.AD_SECONDS);
}

// 테스트에서 값을 바꿀 수 있도록 요청마다 환경 변수를 읽는다.
function adMinSeconds() {
  return Number(process.env.AD_MIN_SECONDS);
}

async function startImpression(userID, contentID) {
  const [contents] = await pool.query('SELECT * FROM content WHERE contentID = ?', [contentID]);
  if (contents.length === 0) return null;
  const content = contents[0];
  const { advertiser, campaign } = pickAd(contentID);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[{ now }]] = await conn.query('SELECT UTC_TIMESTAMP(3) AS now');
    const [inserted] = await conn.query(
      `INSERT INTO ad_impression (userID, contentID, adFormat, advertiser, campaign, startedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userID, contentID, content.adFormat, advertiser, campaign, now]
    );
    const impressionID = inserted.insertId;
    await conn.query(
      `INSERT INTO event_log (userID, eventType, contentID, occurredAt, payload)
       VALUES (?, 'ad_start', ?, ?, ?)`,
      [userID, contentID, now, JSON.stringify({ impressionID, adFormat: AD_FORMAT[content.adFormat], advertiser, campaign })]
    );
    await conn.commit();
    return {
      impressionID,
      adFormat: AD_FORMAT[content.adFormat],
      advertiser,
      minWatchSec: adMinSeconds(),
      adSeconds: adSeconds(),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// 결과는 { status, body } 모양으로 돌려주고, 라우터는 그대로 응답만 한다.
async function completeImpression(userID, impressionID) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 남의 노출은 userID 조건 때문에 안 보인다. 없는 노출과 같은 응답을 준다.
    const [imps] = await conn.query('SELECT * FROM ad_impression WHERE impressionID = ? AND userID = ?', [impressionID, userID]);
    if (imps.length === 0) {
      await conn.rollback();
      return { status: 404, body: { error: 'impression_not_found' } };
    }
    const imp = imps[0];

    // 이미 완료된 노출은 시간 검사 없이 그대로 200 (멱등).
    if (imp.completedAt !== null) {
      await conn.rollback();
      return { status: 200, body: { completed: true } };
    }

    const [[{ now }]] = await conn.query('SELECT UTC_TIMESTAMP(3) AS now');
    const minMs = adMinSeconds() * 1000;
    const elapsedMs = now.getTime() - imp.startedAt.getTime();
    if (elapsedMs < minMs) {
      await conn.rollback();
      return { status: 400, body: { error: 'too_early', retryAfterMs: minMs - elapsedMs } };
    }

    // 조건부 UPDATE: 동시에 두 번 불려도 한 요청만 completedAt을 채운다.
    const [updated] = await conn.query(
      'UPDATE ad_impression SET completedAt = ? WHERE impressionID = ? AND userID = ? AND completedAt IS NULL',
      [now, impressionID, userID]
    );
    // affectedRows가 1일 때만 이벤트를 남긴다. 0이면 다른 요청이 이미 완료한 것이라 아무것도 기록하지 않는다.
    if (updated.affectedRows === 1) {
      await conn.query(
        `INSERT INTO event_log (userID, eventType, contentID, occurredAt, payload)
         VALUES (?, 'ad_complete', ?, ?, ?)`,
        [userID, imp.contentID, now, JSON.stringify({ impressionID })]
      );
    }
    await conn.commit();
    return { status: 200, body: { completed: true } };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

const router = express.Router();

router.post('/ads/impressions', requireUser, async (req, res, next) => {
  try {
    const contentID = req.body && req.body.contentID;
    // 정수가 아니면 없는 콘텐츠로 본다 (6-2에 정의된 에러는 content_not_found뿐이다).
    const result = Number.isInteger(contentID) ? await startImpression(req.userID, contentID) : null;
    if (result === null) {
      return res.status(404).json({ error: 'content_not_found' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/ads/impressions/:id/complete', requireUser, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(404).json({ error: 'impression_not_found' });
    }
    const { status, body } = await completeImpression(req.userID, Number(req.params.id));
    res.status(status).json(body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
