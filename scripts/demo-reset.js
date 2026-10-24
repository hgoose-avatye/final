// 시연 전용(개발용) 리셋. 서비스 코드가 아니다. `npm run demo:reset [초]`
// 시연 유저(userID=1)의 user_content_state 세 행만 아래 상태로 만든다. event_log, reward, ad_impression은 건드리지 않는다.
//   튜브 낚시 : 지금 + N초 뒤에 가능 (기본 90초), 오늘 횟수 0
//   방문 보너스: 방금 적립한 상태 (다음 가능 시각은 cooldown.js의 computeNextAvailableAt로 계산)
//   출석체크   : 가능 상태 (행 삭제. 행이 없으면 가능이다 - 5-2)
// 이유: 시연은 "낚시가 곧 끝나고, 방문 보너스는 기다리고, 출석체크는 지금 한다"는 순서를 매번 같은 모양으로 시작해야 한다.
// 현재 시각은 앱 서버의 Date.now()가 아니라 DB(UTC_TIMESTAMP(3))에서 읽는다 (3장).
const pool = require('../src/db');
const { computeNextAvailableAt } = require('../src/cooldown');

const DEMO_USER_ID = 1;
const DEFAULT_SECONDS = 90;
const FISHING = 1;
const ATTENDANCE = 2;
const BONUS = 3;

// 한국 시간 HH:mm (요약 줄에만 쓴다). 서머타임이 없어서 +9시간이면 된다.
function kstHHmm(date) {
  const kst = new Date(date.getTime() + 9 * 3600 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

// 세 행을 한 커넥션의 한 트랜잭션에서 바꾼다: 중간에 실패해도 반쯤 바뀐 상태로 시연을 시작하지 않게 한다.
async function resetDemo(userID, seconds) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[{ now }]] = await conn.query('SELECT UTC_TIMESTAMP(3) AS now');
    const [[bonus]] = await conn.query('SELECT * FROM content WHERE contentID = ?', [BONUS]);
    if (!bonus) throw new Error(`방문 보너스(contentID ${BONUS})가 content 테이블에 없어요. db/seed.sql을 확인해 주세요.`);

    // 행이 없으면 먼저 만든다 (claim의 5번과 같은 방식). 만든 뒤에는 UPDATE로 값을 정한다.
    for (const contentID of [FISHING, BONUS]) {
      await conn.query('INSERT IGNORE INTO user_content_state (userID, contentID) VALUES (?, ?)', [userID, contentID]);
    }

    await conn.query(
      'UPDATE user_content_state SET nextAvailableAt = ?, todayCount = 0, countDayStart = NULL WHERE userID = ? AND contentID = ?',
      [new Date(now.getTime() + seconds * 1000), userID, FISHING],
    );

    const bonusNext = computeNextAvailableAt(bonus, now);
    await conn.query(
      'UPDATE user_content_state SET lastRewardAt = ?, nextAvailableAt = ? WHERE userID = ? AND contentID = ?',
      [now, bonusNext, userID, BONUS],
    );

    await conn.query('DELETE FROM user_content_state WHERE userID = ? AND contentID = ?', [userID, ATTENDANCE]);

    await conn.commit();
    return `demo:reset userID=${userID} | 튜브 낚시 ${seconds}초 뒤 가능 | 방문 보너스 방금 적립(다음 한국 ${kstHHmm(bonusNext)}) | 출석체크 참여 가능`;
  } catch (error) {
    try {
      await conn.rollback();
    } catch (rollbackError) {
      // rollback이 실패해도 원래 에러를 던진다 (리뷰 L-3와 같은 이유)
    }
    throw error;
  } finally {
    conn.release();
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  // 개발 환경에서만 동작한다 (/dev/token과 같은 조건, 9-3장). 운영 DB에서 실수로 돌리지 않게 DB에 접속하기 전에 막는다.
  if (process.env.NODE_ENV !== 'development') {
    fail('NODE_ENV=development일 때만 실행해요. 시연 전용 스크립트라 다른 환경에서는 동작하지 않아요.');
  }
  const arg = process.argv[2];
  const seconds = arg === undefined ? DEFAULT_SECONDS : Number(arg);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    fail('초는 1 이상의 정수로 적어 주세요. 예: npm run demo:reset -- 30');
  }
  try {
    console.log(await resetDemo(DEMO_USER_ID, seconds));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => fail(error.message));
}

module.exports = { resetDemo };
