// GET /cooldowns (6-1). 읽기 전용: 쓰기도, 행 생성도 하지 않는다 (5-2).
// 라우터는 입력 확인과 응답만 한다. 조회 로직은 getCooldowns 함수에 분리했다.
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');
const { kstDayStart, nextKstMidnight } = require('../cooldown');

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

// 오늘 남은 횟수 (M7). 한도가 없으면 null.
// 카운터는 "어느 날 센 값인지"(countDayStart)가 오늘의 시작과 같을 때만 오늘 값이다. 다르면(어제 이전이거나 행이 없으면) 0번 쓴 것이다.
function remainingToday(row, serverTime) {
  if (row.dailyLimit === null) return null;
  const countedToday = row.countDayStart !== null && row.countDayStart.getTime() === kstDayStart(serverTime).getTime();
  return Math.max(0, row.dailyLimit - (countedToday ? row.todayCount : 0));
}

function toContentView(row, serverTime) {
  const remaining = remainingToday(row, serverTime);

  // ready: 행이 없거나(NULL), 저장된 시각이 이미 지났을 때. 대기 중일 때만 미래 시각을 내려 준다.
  let ready = row.nextAvailableAt === null || row.nextAvailableAt <= serverTime;
  let nextAvailableAt = row.nextAvailableAt;

  // 오늘 한도가 다 찼으면 쿨타임이 지났어도 지금은 할 수 없다. 다시 할 수 있는 때는 다음 한국 00:00이다.
  // 저장된 쿨타임이 그보다 늦으면(자정 직전 적립) 그 값이 더 늦으므로 그대로 쓴다. 홈과 알림이 이 값을 그대로 쓴다.
  if (remaining === 0) {
    const midnight = nextKstMidnight(serverTime);
    ready = false;
    nextAvailableAt = nextAvailableAt !== null && nextAvailableAt > midnight ? nextAvailableAt : midnight;
  }

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
