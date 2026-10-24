// MySQL 커넥션 풀. 접속 정보는 환경 변수에서만 읽는다 (9-3장).
// timezone: 'Z'는 드라이버가 DATETIME을 UTC로 읽고 쓰게 한다 (3장). 이게 없으면 서버 로컬 시간대로 해석되어 시각이 어긋난다.
// dateStrings를 쓰지 않는 이유: DATETIME(3)을 Date 객체로 받아야 ISO 문자열로 바꾸기 쉽다.
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  timezone: 'Z',
  connectionLimit: 10,
});

module.exports = pool;
