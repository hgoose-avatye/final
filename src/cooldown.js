// 다음 적립 가능 시각 계산. 순수 함수만 둔다.
// 이유: DB, 네트워크, 현재 시각을 읽지 않아야 경계(정각, 자정)를 테스트로 정확히 고정할 수 있다.
// 현재 시각은 항상 인자(nowUtc)로 받는다. 호출하는 쪽이 DB의 UTC_TIMESTAMP(3)를 읽어 넘긴다 (3장).

// 한국은 서머타임이 없어서 고정 +9시간 오프셋이면 충분하다.
const KST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 86400000;

function computeNextAvailableAt(content, nowUtc) {
  if (content.cooldownType === 0) {
    return nextByInterval(content.intervalSec, nowUtc);
  }
  return nextByDailyReset(content.resetTimesKST, nowUtc);
}

// interval: 마지막 적립(= now) 시각에서 intervalSec 뒤.
// 이유: claim은 적립하는 바로 그 순간(now)에만 이 함수를 부른다. 그래서 "마지막 적립 시각"이 곧 now이고,
// DB에서 lastRewardAt을 따로 읽을 필요가 없다 (이 함수가 DB를 읽지 않는 순수 함수로 남는 이유이기도 하다).
function nextByInterval(intervalSec, nowUtc) {
  return new Date(nowUtc.getTime() + intervalSec * 1000);
}

// dailyReset: 한국 시간 기준으로 "지금보다 엄격하게 늦은" 가장 이른 초기화 시각.
// 이유: 엄격하게(>) 비교해야 정확히 초기화 시각에 적립해도 같은 시각이 다음 가능 시각이 되지 않고,
// 다음 초기화 시각으로 넘어간다. 그렇지 않으면 방금 적립했는데 바로 또 가능해지는 오판정이 생긴다.
function nextByDailyReset(resetTimesKST, nowUtc) {
  // UTC 값에 9시간을 더하면 getUTC* 함수가 한국 시각을 돌려준다. 그래서 '가짜 UTC'로 한국 날짜를 계산한다.
  const kstNowMs = nowUtc.getTime() + KST_OFFSET_MS;
  const kstNow = new Date(kstNowMs);
  const kstDayStartMs = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());

  const timesOfDayMs = toSortedMsOfDay(resetTimesKST);

  // 오늘 후보가 모두 지났으면 내일의 가장 이른 후보가 걸린다. 그래서 오늘, 내일 두 날만 보면 된다.
  for (const dayOffset of [0, 1]) {
    for (const timeOfDayMs of timesOfDayMs) {
      const candidateKstMs = kstDayStartMs + dayOffset * DAY_MS + timeOfDayMs;
      if (candidateKstMs > kstNowMs) {
        return new Date(candidateKstMs - KST_OFFSET_MS);
      }
    }
  }
}

// ["16:00","00:00"] → 하루 안의 밀리초로 바꿔 이른 순으로 정렬한다.
// 이유: DB에 적힌 순서를 믿지 않고, "가장 이른 후보"를 항상 앞에서부터 찾을 수 있게 한다.
function toSortedMsOfDay(resetTimesKST) {
  return resetTimesKST
    .map((hhmm) => {
      const [hour, minute] = hhmm.split(':').map(Number);
      return (hour * 60 + minute) * 60000;
    })
    .sort((a, b) => a - b);
}

// 하루 한도(M7)의 "하루": 현재 시각이 속한 한국 날짜의 00:00을 UTC로 돌려준다.
// 이유: 한도 카운터가 "어느 날 센 값인지"를 이 값으로 구분한다. 값이 바뀌면 새 날이고 카운터는 1부터 다시 센다.
// nextByDailyReset과 경계가 다르다: 정확히 한국 00:00:00.000이면 그 시각이 "다음"이 아니라 "그 날의 시작"이다.
// (초기화 시각에 적립하면 새 날의 첫 적립이어야 하기 때문이다. 테스트 C8로 고정했다.)
function kstDayStart(nowUtc) {
  const kstNow = new Date(nowUtc.getTime() + KST_OFFSET_MS);
  const kstDayStartAsFakeUtcMs = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());
  return new Date(kstDayStartAsFakeUtcMs - KST_OFFSET_MS);
}

// 한도가 찬 유저가 다시 할 수 있게 되는 시각: 다음 한국 00:00.
function nextKstMidnight(nowUtc) {
  return new Date(kstDayStart(nowUtc).getTime() + DAY_MS);
}

// 오늘 남은 횟수 (M7). 한도가 없으면 null.
// 이유: 화면에 보여 줄 값(GET /cooldowns)과 적립 직후의 응답(claim)이 같은 규칙으로 계산해야 두 곳이 어긋나지 않는다.
// todayCount는 countDayStart가 "오늘의 시작"과 같을 때만 오늘의 횟수다. 다르거나(어제 이전) NULL이면(행이 없다) 오늘은 0번 쓴 것이다.
// 한도를 낮춰서 센 횟수가 한도를 넘어도 0 아래로 내려가지 않는다.
function remainingTodayOf({ dailyLimit, todayCount, countDayStart }, nowUtc) {
  if (dailyLimit === null || dailyLimit === undefined) return null;
  const countedToday = countDayStart != null && countDayStart.getTime() === kstDayStart(nowUtc).getTime();
  return Math.max(0, dailyLimit - (countedToday ? todayCount : 0));
}

// "다시 할 수 있는 시각"에 하루 한도를 반영한다 (M7). 한도가 다 찼을 때(remainingToday === 0)만 값이 바뀐다.
// 이유: 한도가 찬 유저는 쿨타임이 끝나도 다음 한국 00:00까지 못 한다. 그래서 저장된 쿨타임과 다음 자정 중 더 늦은 시각이 진짜 답이다.
// (저장된 쿨타임이 자정보다 늦으면, 예를 들어 자정 직전에 적립했다면, 그 값이 더 늦다.)
// 저장된 값(DB의 nextAvailableAt)은 쿨타임 그대로 두고, 읽을 때(GET)와 응답할 때(claim)만 이 함수로 반영한다.
function limitAwareNextAvailableAt(nextAvailableAt, remainingToday, nowUtc) {
  if (remainingToday !== 0) return nextAvailableAt;
  const midnight = nextKstMidnight(nowUtc);
  return nextAvailableAt !== null && nextAvailableAt.getTime() > midnight.getTime() ? nextAvailableAt : midnight;
}

module.exports = { computeNextAvailableAt, kstDayStart, nextKstMidnight, remainingTodayOf, limitAwareNextAvailableAt };
