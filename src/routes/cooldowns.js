// GET /cooldowns (6-1). 읽기 전용: 쓰기도, 행 생성도 하지 않는다 (5-2).
// 라우터는 입력 확인과 응답만 한다. 조회 로직은 getCooldowns 함수에 분리했다.
const express = require('express');
const pool = require('../db');
const { requireUser } = require('../auth');

const REWARD_TYPE = ['point', 'ticket'];
const AD_FORMAT = ['video', 'install'];

// 쿼리 한 번으로 모든 콘텐츠를 가져온다 (콘텐츠마다 쿼리하지 않는다, 9-2장).
// LEFT JOIN: 행이 없는 콘텐츠(처음)도 나와야 하므로. 이때 nextAvailableAt은 NULL이다.
// serverTime을 같은 쿼리에서 읽는 이유: 판정에 쓰는 '지금'이 DB 시각 하나로 통일되고, 앱 서버의 시계를 믿지 않는다 (3장).
async function getCooldowns(userID) {
  const [rows] = await pool.query(
    `SELECT c.contentID, c.name, c.rewardType, c.rewardAmount, c.adFormat,
            s.nextAvailableAt, UTC_TIMESTAMP(3) AS serverTime
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

function toContentView(row, serverTime) {
  // ready: 행이 없거나(NULL), 저장된 시각이 이미 지났을 때. 대기 중일 때만 미래 시각을 내려 준다.
  const ready = row.nextAvailableAt === null || row.nextAvailableAt <= serverTime;
  return {
    contentID: row.contentID,
    name: row.name,
    ready,
    nextAvailableAt: ready ? null : row.nextAvailableAt.toISOString(),
    rewardType: REWARD_TYPE[row.rewardType],
    rewardAmount: row.rewardAmount,
    adFormat: AD_FORMAT[row.adFormat],
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
