// 화면 공용 코드: 토큰 보관, API 호출, 이벤트 전송.
// 토큰은 주소의 ?token=으로 한 번 받아 sessionStorage에 저장한다 (개발용, 7장).

function loadToken() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    sessionStorage.setItem('token', fromUrl);
    // 주소창에 토큰이 남지 않게 지운다.
    params.delete('token');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
  }
  return sessionStorage.getItem('token');
}

const token = loadToken();

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
