// MySQL 커넥션 풀. 접속 정보는 환경 변수에서만 읽는다 (9-3장).
// timezone: 'Z'는 드라이버가 DATETIME을 UTC로 읽고 쓰게 한다 (3장). 이게 없으면 서버 로컬 시간대로 해석되어 시각이 어긋난다.
// dateStrings를 쓰지 않는 이유: DATETIME(3)을 Date 객체로 받아야 ISO 문자열로 바꾸기 쉽다.
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  // 비밀이 아닌 값은 스펙 2-5장의 기본값을 둔다. 비밀번호는 기본값 없이 환경 변수에서만 읽는다.
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'reward',
  timezone: 'Z',
  connectionLimit: 10,
});

module.exports = pool;
