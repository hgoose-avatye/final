// POST /events (6-5). 클라이언트 이벤트 4종만 받는다.
// 이유: ad_start, claim_ok 같은 서버 이벤트를 클라이언트가 보낼 수 있으면 지표(8장)를 조작할 수 있다 (9-3).
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');

const CLIENT_EVENT_TYPES = new Set(['home_enter', 'cooldown_view', 'content_enter', 'alarm_shown']);
const MAX_EVENTS = 50;

// 하나라도 잘못되면 전부 거절한다 ("아무것도 저장하지 않음").
// 이유: 일부만 저장하면 클라이언트가 어디까지 저장됐는지 알 수 없어 재전송 시 중복이 생긴다.
function validate(events) {
  if (!Array.isArray(events)) return 'invalid_event_type';
  if (events.length > MAX_EVENTS) return 'too_many';
  for (const event of events) {
    if (!event || !CLIENT_EVENT_TYPES.has(event.eventType)) return 'invalid_event_type';
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
    Number.isInteger(event.contentID) ? event.contentID : null,
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
