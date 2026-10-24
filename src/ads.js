// 모의 광고주 선택 (6-2). 광고 선택·편성 로직을 키우지 않는다 (12장). contentID별 목록에서 무작위로 하나 고를 뿐이다.
// 광고주 목록은 직접 관찰한 값이고 시간에 따라 바뀐다 (13장). 바뀌면 이 표만 고친다.
const ADVERTISERS = {
  1: ['토스'],
  2: ['트립닷컴', '킹샷', '네이버페이'],
};

function pickAd(contentID) {
  const list = ADVERTISERS[contentID] || ['모의 광고주'];
  const advertiser = list[Math.floor(Math.random() * list.length)];
  // campaign은 지금 구분할 정보가 없어 비워 둔다 (컬럼은 NULL 허용).
  return { advertiser, campaign: null };
}

module.exports = { pickAd };
