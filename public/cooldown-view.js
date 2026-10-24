// 시연용 홈(home.html)과 쿨타임 목록(cooldowns.html)이 같이 쓰는 "모양" 코드 (M9). app.js 다음에 불러온다.
// 시계(formatClock), 분리·정렬(splitCooldowns), 가장 먼저 끝나는 하나(nextToFinish), 한국 날짜 기준 "내일"(formatAvailableAt),
// 알림 판정(checkAlarms)은 app.js에 있다. 첫 M9(PR #10)에서 머지되었고 index.html도 같이 쓰므로 여기에 다시 만들지 않는다
// (같은 이름의 const를 두 스크립트가 선언하면 SyntaxError로 페이지가 깨진다).
// 이 파일에는 시연용 화면에만 필요한 것을 둔다: 이모지, 화면 이름, 홈 격자의 순서.
// 서버 판정은 건드리지 않는다. 순수 함수는 test/cooldown-list.test.js가 vm으로 불러와 확인한다 (브라우저와 node에서 같이 쓰는 가장 단순한 방식).

// ---- 모양만 정하는 값 (서버 값이 아니다. 모르는 콘텐츠는 서버가 준 이름과 기본 ⭐을 쓴다) ----
const ICONS = { 1: '🎣', 2: '📅', 3: '🎁' };
const DISPLAY_NAMES = { 1: '튜브 낚시' }; // 서버의 이름은 "낚시"지만 실서비스 화면에서는 "튜브 낚시"라고 부른다.
const HOME_ORDER = [2, 1, 3]; // 홈 격자의 고정 순서: 출석체크, 튜브 낚시, 방문 보너스

// app.js의 showAlarm이 이 함수가 있으면 알림 문구에도 같은 이름을 쓴다.
function displayName(content) {
  return DISPLAY_NAMES[content.contentID] || content.name;
}

function iconOf(content) {
  return ICONS[content.contentID] || '⭐';
}

// 홈 격자의 순서. 상태(ready 여부)와 상관없이 고정이라 칸이 자리를 옮기지 않는다. 그 밖의 콘텐츠는 뒤에 contentID 순.
// 받은 배열은 바꾸지 않는다.
function orderForHome(contents) {
  const rank = (c) => {
    const index = HOME_ORDER.indexOf(c.contentID);
    return index === -1 ? HOME_ORDER.length : index;
  };
  return [...contents].sort((a, b) => (rank(a) - rank(b)) || (a.contentID - b.contentID));
}
