// 다음 가능 시각의 표시 형식 테스트. 적립 직후, 쿨타임 중 문구, 목록 화면이 모두 formatNextTime 하나를 쓴다 (QA-2).
// 한국 날짜가 같으면 "HH:mm", 다음 날이면 "내일 HH:mm". 브라우저 없이 vm 샌드박스로 (app.test.js와 같은 방식).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { URLSearchParams, location: { search: '', pathname: '/' }, history: { replaceState() {} }, fetch: async () => ({}) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), sandbox);

test('formatNextTime: 한국 날짜가 같으면 HH:mm만', () => {
  const now = Date.parse('2026-10-24T03:00:00.000Z'); // 한국 24일 12:00
  assert.equal(sandbox.formatNextTime('2026-10-24T05:12:00.000Z', now), '14:12');
});

test('formatNextTime: 한국 날짜가 다음 날이면 "내일 HH:mm"', () => {
  const now = Date.parse('2026-10-24T03:00:00.000Z'); // 한국 24일 12:00
  assert.equal(sandbox.formatNextTime('2026-10-24T15:00:00.000Z', now), '내일 00:00'); // 한국 25일 00:00
  assert.equal(sandbox.formatNextTime('2026-10-25T02:30:00.000Z', now), '내일 11:30'); // 한국 25일 11:30
});

test('formatNextTime: 자정 경계 - 한국 23:59:59.999의 다음 00:00은 "내일", 00:00 정각의 같은 시각은 오늘', () => {
  // 한국 23:59:59.999 (UTC 14:59:59.999) 에서 다음 한국 00:00은 내일이다.
  assert.equal(sandbox.formatNextTime('2026-10-24T15:00:00.000Z', Date.parse('2026-10-24T14:59:59.999Z')), '내일 00:00');
  // 한국 00:00:00.000 정각은 새 날의 시작이다. 같은 시각을 가리키면 오늘이다 (5-1의 경계 규칙과 같은 방향).
  assert.equal(sandbox.formatNextTime('2026-10-24T15:00:00.000Z', Date.parse('2026-10-24T15:00:00.000Z')), '00:00');
  // 같은 날의 마지막 분은 오늘이다.
  assert.equal(sandbox.formatNextTime('2026-10-24T14:59:59.999Z', Date.parse('2026-10-24T03:00:00.000Z')), '23:59');
});

test('formatNextTime: 날짜는 UTC가 아니라 한국 기준으로 가른다 (UTC로는 같은 날, 한국으로는 내일)', () => {
  const now = Date.parse('2026-10-24T03:00:00.000Z'); // 한국 24일 12:00, UTC 24일
  assert.equal(sandbox.formatNextTime('2026-10-24T16:30:00.000Z', now), '내일 01:30'); // UTC 24일이지만 한국 25일
});

test('formatAvailableAt은 formatNextTime 뒤에 "에 가능"만 붙인다 (목록 화면의 기존 문구 그대로)', () => {
  const now = Date.parse('2026-10-24T03:00:00.000Z');
  assert.equal(sandbox.formatAvailableAt('2026-10-24T05:12:00.000Z', now), '14:12에 가능');
  assert.equal(sandbox.formatAvailableAt('2026-10-24T15:00:00.000Z', now), '내일 00:00에 가능');
});
