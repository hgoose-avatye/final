// 화면 공용 코드: 토큰 보관, API 호출, 이벤트 전송.
// 토큰은 주소의 ?token=으로 한 번 받아 localStorage에 저장한다 (개발용, 7장).
// sessionStorage가 아니라 localStorage인 이유: 탭마다 따로 저장되면 링크를 새 탭에서 열 때 로그인이 풀린다.
// 저장소 접근이 막힌 환경(사생활 보호 모드 등)에서는 예외가 나므로, 메모리 변수로 되돌아간다 (그 탭에서만 유지된다).

let memoryToken = null;

function readStoredToken() {
  try {
    return localStorage.getItem('token');
  } catch (e) {
    return memoryToken;
  }
}

function writeStoredToken(value) {
  memoryToken = value; // 저장소가 막혀도 이 탭에서는 쓸 수 있게 항상 메모리에도 둔다
  try {
    localStorage.setItem('token', value);
  } catch (e) { /* 막힌 환경: 메모리만 쓴다 */ }
}

function clearStoredToken() {
  memoryToken = null;
  try {
    localStorage.removeItem('token');
  } catch (e) { /* 막힌 환경: 지울 것이 없다 */ }
}

function loadToken() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    writeStoredToken(fromUrl);
    // 주소창에 토큰이 남지 않게 지운다.
    params.delete('token');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
  }
  return readStoredToken();
}

let token = loadToken();

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  // 서버가 거절한 토큰은 지운다. localStorage는 닫아도 남으므로, 낡은 토큰이 계속 걸리지 않게 한다.
  if (res.status === 401) {
    clearStoredToken();
    token = null;
  }
  return { status: res.status, ok: res.ok, body };
}

// 클라이언트 이벤트 전송 (6-5). 실패해도 화면 동작을 막지 않는다 (로그가 화면보다 중요하지 않다).
// 발생 시각은 보내지 않는다. 서버가 정한다 (3장).
function sendEvents(events) {
  return api('/events', { method: 'POST', body: JSON.stringify({ events }) }).catch(() => {});
}

// 서버가 준 UTC 시각(ISO)을 한국 시간 HH:mm으로 바꾼다.
// 기기의 시간대 설정에 의존하지 않도록 UTC에 9시간을 더해 getUTC*로 읽는다 (3장).
function formatKstHHmm(isoString) {
  const kst = new Date(Date.parse(isoString) + 9 * 3600 * 1000);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 남은 시간(ms)을 쉬운 말로: "1시간 5분 뒤", "42분 뒤", "곧 가능" (7-1).
function formatRemaining(remainingMs) {
  const totalMinutes = Math.floor(remainingMs / 60000);
  if (totalMinutes < 1) return '곧 가능';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}분 뒤`;
  if (minutes === 0) return `${hours}시간 뒤`;
  return `${hours}시간 ${minutes}분 뒤`;
}

// 하루 한도(M7)의 남은 횟수 문구. 한도가 있고 아직 남았을 때만 보여 준다. 필드가 없거나(null, undefined) 0이면 빈 문자열이다.
function formatLimitLine(remainingToday) {
  return Number.isInteger(remainingToday) && remainingToday > 0 ? `오늘 ${remainingToday}번 남았어요` : '';
}

function formatReward(content) {
  return content.rewardType === 'ticket'
    ? `티켓 ${content.rewardAmount}장`
    : `${content.rewardAmount}포인트`;
}

// ---- 쿨타임 표시 (M9: 홈 카드, 홈 진입점, 쿨타임 목록 페이지가 같이 쓴다) ----
// 서버 판정은 건드리지 않는다. /cooldowns 응답을 보기 좋게 나누고 다듬기만 한다.

// 남은 시간(ms)을 시계로: 1시간 미만 "59:49", 이상 "05:25:20".
// 올림하는 이유: 화면이 00:00이 되는 순간이 실제 남은 시간 0과 같아야, 그때 서버에 다시 물어보는 시점과 맞는다.
function formatClock(remainingMs) {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hours === 0 ? `${mm}:${ss}` : `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
}

// 시계 앞의 말. 출석체크(2)는 "출석"이라고 부른다. 모양만 정하는 값이라 서버 값이 아니라 여기에 둔다.
function clockLabel(content) {
  return content.contentID === 2 ? '다음 출석까지' : '다음 가능까지';
}

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

// "14:12에 가능", 한국 날짜가 내일 이후면 "내일 00:00에 가능".
// 날짜는 UTC가 아니라 한국 기준으로 가른다: 한국 00:00은 UTC로는 전날 15:00이라 UTC로 비교하면 날짜가 어긋난다.
// nowMs는 서버 시각 기준이어야 한다(기기 시계 금지, 3장). 호출하는 쪽이 넘겨 준다.
function formatAvailableAt(nextAvailableAt, nowMs) {
  const KST_MS = 9 * 3600 * 1000;
  const DAY_MS = 24 * 3600 * 1000;
  const dayOf = (ms) => Math.floor((ms + KST_MS) / DAY_MS);
  const nextMs = Date.parse(nextAvailableAt);
  const prefix = dayOf(nextMs) > dayOf(nowMs) ? '내일 ' : '';
  return `${prefix}${formatKstHHmm(nextAvailableAt)}에 가능`;
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
  // 시연용 화면(cooldown-view.js)을 같이 불러온 페이지는 화면 이름("튜브 낚시")으로 알린다. index.html은 불러오지 않아 서버 이름을 쓴다.
  const name = typeof displayName === 'function' ? displayName(content) : content.name;
  const text = `${name} 다시 할 수 있어요`;
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
