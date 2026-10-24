// 환경 변수와 개발용 엔드포인트 테스트 (리뷰 M-1, /dev/token).
// app은 만들 때 환경 변수를 읽으므로, 환경을 바꿔 가며 확인하려고 자식 프로세스에서 실행한다. DB에는 접속하지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// 현재 환경에서 지정한 이름을 지우거나 바꾼 환경으로 코드를 실행한다.
function runWithEnv(overrides, code) {
  const env = { ...process.env, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
}

test('AUTH_SECRET이 없으면 기동하지 않고 이유를 알려 준다', () => {
  const result = runWithEnv({ AUTH_SECRET: undefined }, `require(${JSON.stringify(SERVER)})`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AUTH_SECRET/);
});

test('ADMIN_TOKEN이 비어 있으면 기동하지 않고 이유를 알려 준다', () => {
  const result = runWithEnv({ ADMIN_TOKEN: '' }, `require(${JSON.stringify(SERVER)})`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ADMIN_TOKEN/);
});

// /dev/token을 NODE_ENV별로 호출해 "상태 코드 토큰유무"를 출력하는 코드.
const probeDevToken = `
  const app = require(${JSON.stringify(SERVER)});
  const server = app.listen(0, '127.0.0.1', async () => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/dev/token?userID=1');
    const body = await res.text();
    console.log(res.status + ' ' + body.includes('"token":'));
    process.exit(0);
  });
`;

test('/dev/token은 NODE_ENV=development에서만 존재한다', () => {
  const dev = runWithEnv({ NODE_ENV: 'development' }, probeDevToken);
  assert.equal(dev.stdout.trim(), '200 true');

  const production = runWithEnv({ NODE_ENV: 'production' }, probeDevToken);
  assert.equal(production.stdout.trim(), '404 false');

  const unset = runWithEnv({ NODE_ENV: undefined }, probeDevToken);
  assert.equal(unset.stdout.trim(), '404 false');
});
