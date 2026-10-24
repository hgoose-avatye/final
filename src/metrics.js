// 지표 계산 (8장): 단계별 이벤트 발생자 수와 재진입 지연.
// 계산 함수(computeFunnel, computeReentry, percentile)는 이벤트 배열만 받는 순수 함수다.
// 이유: DB 없이 손으로 만든 이벤트로 손계산과 비교할 수 있다. DB 읽기는 getMetrics 한 곳에만 둔다.
// 구현은 이벤트를 읽어서 JS로 계산한다. SQL 하나로 하려고 복잡하게 만들지 않는다 (8장).
const pool = require('./db');

// 8장의 단계 순서. home_enter는 contentID가 없어서 모든 콘텐츠의 첫 단계에 같은 값을 쓴다.
const FUNNEL_STEPS = ['home_enter', 'cooldown_view', 'content_enter', 'ad_start', 'ad_complete', 'claim_ok'];

// 구간은 [from, to): from은 포함, to는 제외.
function inRange(event, from, to) {
  const at = event.occurredAt.getTime();
  return at >= from.getTime() && at < to.getTime();
}

// 단계별 이벤트 발생자 수: 구간 안에서 그 이벤트를 한 번이라도 낸 서로 다른 userID의 수.
// 엄밀한 코호트 퍼널이 아니라서, 단계끼리 포함 관계가 아니고 직전 단계 대비 비율이 100%를 넘을 수 있다 (8장).
function computeFunnel(events, contentIDs, from, to) {
  const inside = events.filter((event) => inRange(event, from, to));
  return contentIDs.map((contentID) => ({
    contentID,
    steps: FUNNEL_STEPS.map((step) => {
      const users = new Set();
      for (const event of inside) {
        if (event.eventType !== step) continue;
        if (step !== 'home_enter' && event.contentID !== contentID) continue;
        users.add(event.userID);
      }
      return { step, users: users.size };
    }),
  }));
}

// 재진입 지연: 구간 안의 claim_ok마다, 같은 유저의 같은 콘텐츠에서 N(= payload.nextAvailableAt) 이후
// 가장 이른 content_enter까지의 시간. 쿨타임이 끝난 뒤 유저가 돌아오기까지 걸린 시간이다.
function computeReentry(events, contentIDs, from, to) {
  const inside = events.filter((event) => inRange(event, from, to));
  const claims = inside.filter((event) => event.eventType === 'claim_ok');
  // 돌아온 시각을 찾을 때도 구간의 끝(to)을 넘어서는 보지 않는다. inside에는 이미 to 이전 이벤트만 있다.
  const enters = inside.filter((event) => event.eventType === 'content_enter');

  return contentIDs.map((contentID) => {
    const delaysSec = [];
    let notReturned = 0;

    for (const claim of claims.filter((c) => c.contentID === contentID)) {
      const nextAvailableAt = Date.parse(claim.payload.nextAvailableAt);
      // N 이전의 content_enter(쿨타임 중에 들어온 것)는 무시하려고 >= N 인 것만 본다.
      const returnTimes = enters
        .filter((e) => e.userID === claim.userID && e.contentID === contentID)
        .map((e) => e.occurredAt.getTime())
        .filter((at) => at >= nextAvailableAt);

      if (returnTimes.length === 0) {
        notReturned++;
      } else {
        delaysSec.push((Math.min(...returnTimes) - nextAvailableAt) / 1000);
      }
    }

    delaysSec.sort((a, b) => a - b);
    return {
      contentID,
      returned: delaysSec.length,
      notReturned,
      p50Sec: percentile(delaysSec, 0.5),
      p90Sec: percentile(delaysSec, 0.9),
    };
  });
}

// nearest-rank 백분위수: 정렬한 뒤 ceil(p × n)번째 값. 값이 없으면 null.
// 이유: 보간하지 않으므로 결과가 항상 실제로 있었던 지연 값이라 설명하기 쉽다.
function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil(p * sortedValues.length);
  return sortedValues[rank - 1];
}

// DB에서 구간의 이벤트를 읽어 두 지표를 계산한다.
async function getMetrics(from, to) {
  const [contents] = await pool.query('SELECT contentID FROM content ORDER BY contentID');
  const contentIDs = contents.map((row) => row.contentID);

  const [rows] = await pool.query(
    `SELECT userID, eventType, contentID, occurredAt, payload
       FROM event_log
      WHERE occurredAt >= ? AND occurredAt < ?
        AND eventType IN ('home_enter', 'cooldown_view', 'content_enter', 'ad_start', 'ad_complete', 'claim_ok')`,
    [from, to]
  );

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    funnel: computeFunnel(rows, contentIDs, from, to),
    reentry: computeReentry(rows, contentIDs, from, to),
  };
}

module.exports = { computeFunnel, computeReentry, percentile, getMetrics };
