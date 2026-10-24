// POST /events (6-5). 클라이언트 이벤트 4종만 받는다.
// 이유: ad_start, claim_ok 같은 서버 이벤트를 클라이언트가 보낼 수 있으면 지표(8장)를 조작할 수 있다 (9-3).
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');

const CLIENT_EVENT_TYPES = new Set(['home_enter', 'cooldown_view', 'content_enter', 'alarm_shown']);
// home_enter만 contentID가 없다 (8장 표). 나머지 셋은 contentID가 필수다.
const NEEDS_CONTENT_ID = new Set(['cooldown_view', 'content_enter', 'alarm_shown']);
const MAX_EVENTS = 50;
const MAX_INT = 2147483647; // event_log.contentID는 INT다

function isContentID(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_INT;
}

// 하나라도 잘못되면 전부 거절한다 ("아무것도 저장하지 않음").
// 이유: 일부만 저장하면 클라이언트가 어디까지 저장됐는지 알 수 없어 재전송 시 중복이 생긴다.
// contentID가 필요한 이벤트에 contentID가 없거나 잘못되면 기존 에러 코드(invalid_event_type)로 거절한다.
// 이유: NULL로 저장하면 단계별 발생자 수(8장)에서 콘텐츠를 알 수 없어 조용히 빠져 지표가 틀려진다.
function validate(events) {
  if (!Array.isArray(events)) return 'invalid_event_type';
  if (events.length > MAX_EVENTS) return 'too_many';
  for (const event of events) {
    if (!event || !CLIENT_EVENT_TYPES.has(event.eventType)) return 'invalid_event_type';
    if (NEEDS_CONTENT_ID.has(event.eventType) && !isContentID(event.contentID)) return 'invalid_event_type';
  }
  return null;
}

async function saveEvents(userID, events) {
  if (events.length === 0) return 0;
  // occurredAt은 서버(DB) 시각이다. 요청의 시각 필드는 읽지도 않는다 (3장: 클라이언트 시각은 믿지 않는다).
  const [[{ now }]] = await pool.query('SELECT UTC_TIMESTAMP(3) AS now');
  const values = events.map((event) => [
    userID, // 항상 토큰의 userID. 본문의 userID는 무시한다 (9-3).
    event.eventType,
    NEEDS_CONTENT_ID.has(event.eventType) ? event.contentID : null, // home_enter는 contentID를 저장하지 않는다
    now,
    event.payload && typeof event.payload === 'object' ? JSON.stringify(event.payload) : null,
  ]);
  // 한 문장의 다중 행 INSERT라서 전부 저장되거나 전부 실패한다.
  await pool.query('INSERT INTO event_log (userID, eventType, contentID, occurredAt, payload) VALUES ?', [values]);
  return values.length;
}

const router = express.Router();

router.post('/events', requireUser, async (req, res, next) => {
  try {
    const events = req.body && req.body.events;
    const error = validate(events);
    if (error) {
      return res.status(400).json({ error });
    }
    res.json({ saved: await saveEvents(req.userID, events) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
