// GET /admin/metrics?from=...&to=... (6-6). 운영자 토큰이 필요하다 (X-Admin-Token).
// 라우터는 구간 확인과 응답만 하고, 계산은 metrics.js가 한다.
const express = require('express');
const pool = require('../db');
const { requireAdmin } = require('../auth');
const { computeNextAvailableAt } = require('../cooldown');
const { getMetrics } = require('../metrics');

const DAY_MS = 86400000;
const MIDNIGHT_KST = { cooldownType: 1, resetTimesKST: ['00:00'] };

// from, to가 없으면 오늘 00:00 KST부터 지금까지.
// 이유: 한국 시간 계산은 cooldown.js에만 둔다 (3장). "다음 00:00 KST"에서 하루를 빼면 "오늘 00:00 KST"다.
// 지금 시각은 DB 시각을 쓴다 (3장).
async function defaultRange() {
  const [[{ now }]] = await pool.query('SELECT UTC_TIMESTAMP(3) AS now');
  const nextMidnight = computeNextAvailableAt(MIDNIGHT_KST, now);
  return { from: new Date(nextMidnight.getTime() - DAY_MS), to: now };
}

function parseTime(text) {
  const time = new Date(text);
  return Number.isNaN(time.getTime()) ? null : time;
}

const router = express.Router();

router.get('/admin/metrics', requireAdmin, async (req, res, next) => {
  try {
    const fallback = await defaultRange();
    const from = req.query.from === undefined ? fallback.from : parseTime(req.query.from);
    const to = req.query.to === undefined ? fallback.to : parseTime(req.query.to);
    // 6장에 정의된 에러 코드가 없는 경우라서, 읽을 수 없는 시각은 invalid_range로 거절한다.
    if (from === null || to === null) {
      return res.status(400).json({ error: 'invalid_range' });
    }
    res.json(await getMetrics(from, to));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
