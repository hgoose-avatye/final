// 서명 토큰 검증 (6장). 인증 체계는 이것과 운영자 토큰이 전부다.
// 토큰 형식: <userID>.<hex(HMAC-SHA256(userID, AUTH_SECRET))>
// 이유: userID를 토큰 안에 넣고 서버만 아는 비밀로 서명하면, 클라이언트가 userID를 바꿔 남의 데이터에 접근할 수 없다 (FR-11).
const crypto = require('node:crypto');

function sign(userID) {
  return crypto.createHmac('sha256', process.env.AUTH_SECRET).update(String(userID)).digest('hex');
}

function makeToken(userID) {
  return `${userID}.${sign(userID)}`;
}

// 토큰이 올바르면 userID(숫자)를, 아니면 null을 돌려준다.
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [userID, signature, ...rest] = token.split('.');
  if (rest.length > 0 || !/^\d+$/.test(userID) || !signature) return null;

  const expected = Buffer.from(sign(userID));
  const actual = Buffer.from(signature);
  // 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 비교한다.
  if (expected.length !== actual.length) return null;
  // 일반 비교(===)는 틀린 위치에 따라 걸리는 시간이 달라서, 상수 시간 비교를 쓴다.
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return Number(userID);
}

// 유저 API용. userID는 여기서 토큰으로만 꺼내 req.userID에 둔다 (본문, 쿼리, 경로로는 받지 않는다, 9-3장).
function requireUser(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userID = verifyToken(token);
  if (userID === null) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.userID = userID;
  next();
}

// 운영자 API용. 헤더 X-Admin-Token이 ADMIN_TOKEN과 같아야 한다.
function requireAdmin(req, res, next) {
  const given = Buffer.from(req.get('X-Admin-Token') || '');
  const expected = Buffer.from(process.env.ADMIN_TOKEN || '');
  const ok = given.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(given, expected);
  if (!ok) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = { makeToken, verifyToken, requireUser, requireAdmin };
