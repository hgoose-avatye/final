// 쿨타임 목록 페이지와 시연용 홈(M9)의 화면 공용 순수 함수 테스트.
// 브라우저 없이 vm 샌드박스에 public/app.js와 public/cooldown-view.js를 같은 컨텍스트로 불러온다 (app.test.js와 같은 방식, 새 의존성 없음).
// 알림 판정(checkAlarms)은 모듈 안에 상태(watching, alarmed)가 있으므로 테스트마다 새 샌드박스를 만든다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const readPublic = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const appSource = readPublic('app.js');
const viewSource = readPublic('cooldown-view.js'); // home.html과 cooldowns.html만 불러온다. index.html은 건드리지 않는다.

function loadApp() {
  const toasts = [];
  const events = [];
  const toastElement = { style: { display: 'none' } };
  Object.defineProperty(toastElement, 'textContent', { set(text) { toasts.push(text); }, get() { return toasts[toasts.length - 1]; } });
  const sandbox = {
    URLSearchParams,
    location: { search: '', pathname: '/' },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => 'test-token', setItem() {} },
    fetch: async (url, options) => {
      if (url === '/events') events.push(...JSON.parse(options.body).events);
      return { status: 200, ok: true, json: async () => ({}) };
    },
    window: {}, // Notification이 없으니 알림은 토스트로 떨어진다 (7-2)
    document: { getElementById: () => toastElement },
    setTimeout: () => 0,
    clearTimeout() {},
  };
  // 두 스크립트를 한 컨텍스트에 차례로 올린다. 페이지가 <script> 두 개를 순서대로 불러오는 것과 같다.
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox);
  vm.runInContext(viewSource, sandbox);
  return { app: sandbox, toasts, events };
}

// vm 안에서 만든 배열은 이 파일의 Array와 prototype이 달라 deepEqual이 실패한다. JSON으로 한 번 거쳐 비교한다.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (list) => plain(list.map((c) => c.contentID));

function content(contentID, ready, nextAvailableAt, extra = {}) {
  return { contentID, name: `콘텐츠${contentID}`, ready, nextAvailableAt, remainingToday: null, ...extra };
}

const { app } = loadApp();

test('formatClock: 1시간 미만은 MM:SS, 1시간 이상은 HH:MM:SS', () => {
  assert.equal(app.formatClock(3589 * 1000), '59:49');
  assert.equal(app.formatClock(3600 * 1000), '01:00:00');
  assert.equal(app.formatClock((5 * 3600 + 25 * 60 + 20) * 1000), '05:25:20');
  assert.equal(app.formatClock(9 * 1000), '00:09');
});

test('formatClock: 올림해서 0초가 되는 순간이 실제 0이고, 0 이하는 00:00', () => {
  assert.equal(app.formatClock(1), '00:01');
  assert.equal(app.formatClock(1000), '00:01');
  assert.equal(app.formatClock(0), '00:00');
  assert.equal(app.formatClock(-5000), '00:00');
});

test('clockLabel: 출석체크(2)는 "다음 출석까지", 나머지는 "다음 가능까지"', () => {
  assert.equal(app.clockLabel({ contentID: 2 }), '다음 출석까지');
  assert.equal(app.clockLabel({ contentID: 1 }), '다음 가능까지');
  assert.equal(app.clockLabel({ contentID: 3 }), '다음 가능까지');
});

test('splitCooldowns: 기다리는 중은 nextAvailableAt이 빠른 순(같으면 contentID 순), 지금 가능은 contentID 순', () => {
  const input = [
    content(1, false, '2026-10-24T03:00:00.000Z'),
    content(5, true, null),
    content(4, false, '2026-10-24T02:00:00.000Z'),
    content(2, true, null),
    content(3, false, '2026-10-24T02:00:00.000Z'),
  ];
  const { waiting, ready } = app.splitCooldowns(input);
  assert.deepEqual(ids(waiting), [3, 4, 1]);
  assert.deepEqual(ids(ready), [2, 5]);
  assert.deepEqual(ids(input), [1, 5, 4, 2, 3]); // 받은 배열의 순서를 바꾸지 않는다
});

test('splitCooldowns: 오늘 한도가 찬 항목(ready=false, 내일 00:00)도 기다리는 중에 들어간다', () => {
  const input = [
    content(1, false, '2026-10-24T15:00:00.000Z', { remainingToday: 0 }), // 내일 00:00 KST
    content(2, false, '2026-10-24T05:00:00.000Z'),
  ];
  assert.deepEqual(ids(app.splitCooldowns(input).waiting), [2, 1]);
});

test('splitCooldowns: 비어 있으면 둘 다 빈 배열', () => {
  assert.deepEqual(plain(app.splitCooldowns([])), { waiting: [], ready: [] });
});

test('nextToFinish: 쿨타임 중인 항목 중 가장 먼저 끝나는 하나', () => {
  const input = [
    content(1, false, '2026-10-24T03:00:00.000Z'),
    content(2, true, null),
    content(3, false, '2026-10-24T02:00:00.000Z'),
  ];
  assert.equal(app.nextToFinish(input).contentID, 3);
});

test('nextToFinish: 쿨타임 중인 게 없으면 null (모두 ready이거나 빈 목록)', () => {
  assert.equal(app.nextToFinish([content(1, true, null), content(2, true, null)]), null);
  assert.equal(app.nextToFinish([]), null);
});

test('formatAvailableAt: 한국 시간 HH:mm, 한국 날짜가 내일이면 "내일"을 붙인다', () => {
  const nowMs = Date.parse('2026-10-24T03:00:00.000Z'); // 한국 24일 12:00
  assert.equal(app.formatAvailableAt('2026-10-24T05:12:00.000Z', nowMs), '14:12에 가능');
  assert.equal(app.formatAvailableAt('2026-10-24T15:00:00.000Z', nowMs), '내일 00:00에 가능'); // 한국 25일 00:00
});

test('formatAvailableAt: 한국 날짜는 UTC가 아니라 한국 기준으로 가른다 (UTC로는 같은 날, 한국으로는 내일)', () => {
  const nowMs = Date.parse('2026-10-24T14:00:00.000Z'); // 한국 24일 23:00
  assert.equal(app.formatAvailableAt('2026-10-24T16:30:00.000Z', nowMs), '내일 01:30에 가능'); // 한국 25일 01:30
});

test('checkAlarms: 쿨타임 중이던 항목을 서버가 ready라고 하면 한 번만 알린다 (같은 주기에 중복 없음)', () => {
  const { app: a, toasts, events } = loadApp();
  assert.deepEqual(plain(a.checkAlarms([content(1, false, '2026-10-24T02:00:00.000Z')])), []); // 대기 시작
  const became = a.checkAlarms([content(1, true, null)]); // 서버가 ready
  assert.deepEqual(ids(became), [1]);
  assert.deepEqual(plain(toasts), ['튜브 낚시 다시 할 수 있어요']); // contentID 1은 화면에서 "튜브 낚시"로 부른다
  assert.deepEqual(plain(events), [{ eventType: 'alarm_shown', contentID: 1, payload: { channel: 'toast' } }]);
  assert.deepEqual(plain(a.checkAlarms([content(1, true, null)])), []); // 이후 조회에서는 알릴 전환이 없다
  assert.equal(toasts.length, 1);
});

test('checkAlarms: 처음부터 ready였던 항목은 알리지 않는다', () => {
  const { app: a, toasts } = loadApp();
  assert.deepEqual(plain(a.checkAlarms([content(1, true, null)])), []);
  assert.equal(toasts.length, 0);
});

test('checkAlarms: 같은 nextAvailableAt 주기가 다시 ready로 돌아와도 알림은 한 번, 새 주기는 다시 한 번', () => {
  const { app: a, toasts } = loadApp();
  const waitingX = content(1, false, '2026-10-24T02:00:00.000Z');
  a.checkAlarms([waitingX]);
  a.checkAlarms([content(1, true, null)]);
  a.checkAlarms([waitingX]); // 같은 주기를 다시 봄
  const again = a.checkAlarms([content(1, true, null)]);
  assert.deepEqual(ids(again), [1]); // 전환은 돌려주지만(화면 강조용)
  assert.equal(toasts.length, 1); // 알림은 같은 주기에 한 번뿐
  a.checkAlarms([content(1, false, '2026-10-24T03:00:00.000Z')]); // 새 주기
  a.checkAlarms([content(1, true, null)]);
  assert.equal(toasts.length, 2);
});

test('displayName: 낚시(1)는 화면에서 "튜브 낚시", 나머지는 서버가 준 이름 그대로', () => {
  assert.equal(app.displayName({ contentID: 1, name: '낚시' }), '튜브 낚시');
  assert.equal(app.displayName({ contentID: 2, name: '출석체크' }), '출석체크');
  assert.equal(app.displayName({ contentID: 77, name: '새 콘텐츠' }), '새 콘텐츠');
});

test('iconOf: 아는 콘텐츠는 이모지, 모르는 콘텐츠는 기본 ⭐', () => {
  assert.equal(app.iconOf({ contentID: 1 }), '🎣');
  assert.equal(app.iconOf({ contentID: 2 }), '📅');
  assert.equal(app.iconOf({ contentID: 3 }), '🎁');
  assert.equal(app.iconOf({ contentID: 77 }), '⭐');
});

test('orderForHome: 홈 격자는 출석체크, 튜브 낚시, 방문 보너스 순으로 고정하고(상태와 무관), 그 밖의 콘텐츠는 뒤에 contentID 순', () => {
  const input = [
    content(3, true, null),
    content(90, false, '2026-10-24T03:00:00.000Z'),
    content(1, false, '2026-10-24T03:00:00.000Z'),
    content(2, true, null),
    content(80, true, null),
  ];
  assert.deepEqual(ids(app.orderForHome(input)), [2, 1, 3, 80, 90]);
  assert.deepEqual(ids(input), [3, 90, 1, 2, 80]); // 받은 배열의 순서를 바꾸지 않는다
});

test('orderForHome: 일부만 있어도 있는 것만 그 순서로, 비어 있으면 빈 배열', () => {
  assert.deepEqual(ids(app.orderForHome([content(3, true, null), content(1, true, null)])), [1, 3]);
  assert.deepEqual(plain(app.orderForHome([])), []);
});
