// 화면 공용 코드(public/app.js)의 순수 함수 테스트. 브라우저 없이 vm 샌드박스에 불러온다 (새 의존성 없이).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = {
  URLSearchParams,
  location: { search: '', pathname: '/' },
  history: { replaceState() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  fetch: async () => ({}),
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), sandbox);

test('formatLimitLine: 한도가 남았을 때만 "오늘 N번 남았어요", 없거나(null, undefined) 0이면 빈 문자열', () => {
  assert.equal(sandbox.formatLimitLine(7), '오늘 7번 남았어요');
  assert.equal(sandbox.formatLimitLine(0), '');
  assert.equal(sandbox.formatLimitLine(null), '');
  assert.equal(sandbox.formatLimitLine(undefined), ''); // 필드가 없는 응답에서 "오늘 undefined번"이 나오면 안 된다
});
