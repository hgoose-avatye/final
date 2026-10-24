// 시연용 홈(home.html)과 쿨타임 목록(cooldowns.html)이 같이 쓰는 화면 코드 (M9). app.js 다음에 불러온다.
// 서버 판정은 건드리지 않는다. GET /cooldowns 응답을 보기 좋게 나누고 다듬기만 한다.
// 이 파일이 app.js와 별도인 이유: index.html(개발용 화면)은 알림 코드를 자기 안에 갖고 있어서,
// 같은 이름(watching, alarmed, checkAlarms ...)을 app.js에 두면 index.html이 깨진다. index.html은 수정하지 않기로 했다.
// 순수 함수는 test/cooldown-list.test.js가 vm으로 불러와 확인한다 (브라우저와 node에서 같이 쓰는 가장 단순한 방식).

// ---- 모양만 정하는 값 (서버 값이 아니다. 모르는 콘텐츠는 서버가 준 이름과 기본 ⭐을 쓴다) ----
const ICONS = { 1: '🎣', 2: '📅', 3: '🎁' };
const DISPLAY_NAMES = { 1: '튜브 낚시' }; // 서버의 이름은 "낚시"지만 실서비스 화면에서는 "튜브 낚시"라고 부른다.
const HOME_ORDER = [2, 1, 3]; // 홈 격자의 고정 순서: 출석체크, 튜브 낚시, 방문 보너스

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

// ---- 시계와 문구 ----

// 남은 시간(ms)을 시계로: 1시간 미만 "59:49", 이상 "05:25:20".
// 올림하는 이유: 화면이 00:00이 되는 순간이 실제 남은 시간 0과 같아야, 그때 서버에 다시 물어보는 시점과 맞는다.
function formatClock(remainingMs) {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hours === 0 ? `${mm}:${ss}` : `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
}

// 시계 앞의 말. 출석체크(2)는 "출석"이라고 부른다.
function clockLabel(content) {
  return content.contentID === 2 ? '다음 출석까지' : '다음 가능까지';
}

// "14:12에 가능", 한국 날짜가 내일 이후면 "내일 00:00에 가능".
// 날짜는 UTC가 아니라 한국 기준으로 가른다: 한국 00:00은 UTC로는 전날 15:00이라 UTC로 비교하면 날짜가 어긋난다.
// nowMs는 서버 시각 기준이어야 한다(기기 시계 금지, 3장). 호출하는 쪽이 넘겨 준다.
function formatAvailableAt(nextAvailableAt, nowMs) {
  const KST_MS = 9 * 3600 * 1000;
  const DAY_MS = 24 * 3600 * 1000;
  const dayOf = (ms) => Math.floor((ms + KST_MS) / DAY_MS);
  const prefix = dayOf(Date.parse(nextAvailableAt)) > dayOf(nowMs) ? '내일 ' : '';
  return `${prefix}${formatKstHHmm(nextAvailableAt)}에 가능`;
}

// ---- 분리와 선택 ----

// 지금 할 수 있는 것과 기다리는 것을 나눈다. 받은 배열은 바꾸지 않는다.
// 기다리는 중: nextAvailableAt이 빠른 순(같으면 contentID 순). 오늘 한도가 찬 항목도 여기에 든다(서버가 ready=false와 내일 00:00을 준다).
// 지금 가능: contentID 순.
function splitCooldowns(contents) {
  const waiting = contents
    .filter((c) => !c.ready)
    .sort((a, b) => (Date.parse(a.nextAvailableAt) - Date.parse(b.nextAvailableAt)) || (a.contentID - b.contentID));
  const ready = contents.filter((c) => c.ready).sort((a, b) => a.contentID - b.contentID);
  return { waiting, ready };
}

// 쿨타임 중인 항목 중 가장 먼저 끝나는 하나. 없으면 null.
function nextToFinish(contents) {
  const { waiting } = splitCooldowns(contents);
  return waiting.length > 0 ? waiting[0] : null;
}

// ---- 알림 (7-2). 홈과 목록 페이지가 같은 판정을 쓴다 ----
// watching: 카운트다운을 시작할 때 본 "미래의 nextAvailableAt". 이 값이 같은 쿨타임 주기의 키다.
// (ready 응답의 nextAvailableAt은 null이라 키로 쓸 수 없다.)
const watching = {};         // contentID -> 미래의 nextAvailableAt
const alarmed = new Set();   // "contentID|nextAvailableAt"

// 서버가 확인해 준 상태로만 알림 여부를 정한다.
// 대기 중이면 키를 기록하고, 대기하던 콘텐츠를 서버가 ready라고 하면 그 주기의 알림을 한 번 띄운다.
// 돌려주는 값: 이번 조회에서 "기다리던 것이 ready가 된" 항목들. 알림을 이미 띄운 주기여도 포함한다(화면 강조용).
function checkAlarms(contents) {
  const becameReady = [];
  for (const c of contents) {
    if (!c.ready) {
      watching[c.contentID] = c.nextAvailableAt;
      continue;
    }
    const key = watching[c.contentID];
    if (key === undefined) continue; // 처음부터 ready였다. 알릴 전환이 없다.
    delete watching[c.contentID];
    becameReady.push(c);
    const alarmKey = `${c.contentID}|${key}`;
    if (alarmed.has(alarmKey)) continue;
    alarmed.add(alarmKey);
    showAlarm(c);
  }
  return becameReady;
}

function showAlarm(content) {
  const text = `${displayName(content)} 다시 할 수 있어요`;
  let channel = 'toast';
  if (window.Notification && Notification.permission === 'granted') {
    try {
      new Notification(text);
      channel = 'browser';
    } catch (e) {
      channel = 'toast'; // 일부 환경은 알림 생성이 막혀 있다. 화면 토스트로 대신한다.
    }
  }
  if (channel === 'toast') showToast(text);
  sendEvents([{ eventType: 'alarm_shown', contentID: content.contentID, payload: { channel } }]);
}

let toastTimer = null;
function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 6000);
}
