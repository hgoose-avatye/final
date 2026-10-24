// 화면 공용 코드(public/app.js)의 토큰 보관 테스트. 브라우저 없이 vm 샌드박스로 (app.test.js와 같은 방식).
// 토큰은 탭이 공유하는 localStorage에 둔다. 저장소가 막힌 환경이면 메모리 변수로 되돌아간다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function load({ search = '', localStorage, fetch = async () => ({ status: 200, ok: true, json: async () => ({}) }) } = {}) {
  const sandbox = {
    URLSearchParams,
    location: { search, pathname: '/home.html' },
    history: { replaceState() {} },
    fetch,
  };
  if (localStorage) sandbox.localStorage = localStorage; // 없으면 접근할 때 ReferenceError, 막힌 환경과 같다
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox);
  return { sandbox, token: () => vm.runInContext('token', sandbox) };
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

test('주소의 ?token=은 localStorage에 저장된다 (다른 탭도 읽을 수 있다)', () => {
  const storage = fakeStorage();
  const { token } = load({ search: '?token=abc', localStorage: storage });
  assert.equal(storage.data.token, 'abc');
  assert.equal(token(), 'abc');
});

test('주소에 토큰이 없어도 localStorage에 있으면 쓴다 (새 탭)', () => {
  const { token } = load({ localStorage: fakeStorage({ token: 'saved' }) });
  assert.equal(token(), 'saved');
});

test('저장소가 막혀 있으면(접근하면 예외) 주소의 토큰을 메모리에 들고 있다', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.equal(load({ search: '?token=abc', localStorage: blocked }).token(), 'abc');
});

test('localStorage 자체가 없어도 죽지 않고, 토큰이 없으면 null', () => {
  assert.equal(load({ search: '?token=abc' }).token(), 'abc');
  assert.equal(load().token(), null);
});

test('서버가 401이라고 하면 저장된 토큰을 지운다 (낡은 토큰이 계속 남지 않게)', async () => {
  const storage = fakeStorage({ token: 'stale' });
  const { sandbox, token } = load({
    localStorage: storage,
    fetch: async () => ({ status: 401, ok: false, json: async () => ({ error: 'unauthorized' }) }),
  });
  await sandbox.api('/cooldowns');
  assert.equal('token' in storage.data, false);
  assert.equal(token(), null);
});
