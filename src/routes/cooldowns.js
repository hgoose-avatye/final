// GET /cooldowns (6-1). 읽기 전용: 쓰기도, 행 생성도 하지 않는다 (5-2).
// 라우터는 입력 확인과 응답만 한다. 조회 로직은 getCooldowns 함수에 분리했다.
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');
const { remainingTodayOf, limitAwareNextAvailableAt } = require('../cooldown');

const REWARD_TYPE = ['point', 'ticket'];
const AD_FORMAT = ['video', 'install'];

// 쿼리 한 번으로 모든 콘텐츠를 가져온다 (콘텐츠마다 쿼리하지 않는다, 9-2장).
// LEFT JOIN: 행이 없는 콘텐츠(처음)도 나와야 하므로. 이때 nextAvailableAt은 NULL이다.
// serverTime을 같은 쿼리에서 읽는 이유: 판정에 쓰는 '지금'이 DB 시각 하나로 통일되고, 앱 서버의 시계를 믿지 않는다 (3장).
async function getCooldowns(userID) {
  const [rows] = await pool.query(
    `SELECT c.contentID, c.name, c.rewardType, c.rewardAmount, c.adFormat, c.dailyLimit,
            s.nextAvailableAt, s.todayCount, s.countDayStart, UTC_TIMESTAMP(3) AS serverTime
       FROM content c
       LEFT JOIN user_content_state s
              ON s.contentID = c.contentID AND s.userID = ?
      ORDER BY c.contentID`,
    [userID]
  );

  // 콘텐츠가 0개여도 serverTime을 내려 주기 위한 대비는 하지 않는다 (content는 seed로 항상 있다).
  const serverTime = rows[0].serverTime;
  const contents = rows.map((row) => toContentView(row, serverTime));
  return { serverTime: serverTime.toISOString(), contents };
}

// 한 콘텐츠의 응답 모양을 만든다.
// 남은 횟수와 "다시 할 수 있는 시각"의 계산은 cooldown.js의 공유 함수다. 적립 직후의 응답(claim.js)도 같은 함수를 쓴다.
// 그래서 홈에서 보는 값과 적립 직후 화면의 값이 어긋나지 않는다.
function toContentView(row, serverTime) {
  const remaining = remainingTodayOf(row, serverTime);

  // 한도가 다 찼으면 쿨타임이 지났어도 다음 한국 00:00(또는 더 늦은 쿨타임)까지 못 한다. 한도가 남았으면 저장된 값 그대로다.
  const nextAvailableAt = limitAwareNextAvailableAt(row.nextAvailableAt, remaining, serverTime);

  // ready: 행이 없거나(NULL), 위에서 구한 시각이 이미 지났을 때. 한도가 다 찬 경우는 시각이 미래(다음 자정 이후)라서 자연히 false다.
  // 대기 중일 때만 미래 시각을 내려 준다.
  const ready = nextAvailableAt === null || nextAvailableAt <= serverTime;

  return {
    contentID: row.contentID,
    name: row.name,
    ready,
    nextAvailableAt: ready ? null : nextAvailableAt.toISOString(),
    rewardType: REWARD_TYPE[row.rewardType],
    rewardAmount: row.rewardAmount,
    adFormat: AD_FORMAT[row.adFormat],
    dailyLimit: row.dailyLimit,
    remainingToday: remaining,
  };
}

const router = express.Router();

router.get('/cooldowns', requireUser, async (req, res, next) => {
  try {
    res.json(await getCooldowns(req.userID));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
