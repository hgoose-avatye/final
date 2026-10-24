// 앱 시작, 라우터 연결, 정적 파일 제공.
// app을 export하고 직접 실행될 때만 listen한다. 테스트가 require해서 임시 포트(0)로 listen할 수 있게 하기 위해서다.
const express = require('express');
const path = require('node:path');
const { makeToken } = require('./auth');

const app = express();
app.use(express.json());

// 개발용 토큰 발급 (6장). development에서만 존재하고 그 외에는 404다.
// 라우트 자체를 등록하지 않는 방식이라, 운영 환경에서 실수로 열릴 일이 없다.
if (process.env.NODE_ENV === 'development') {
  app.get('/dev/token', (req, res) => {
    const userID = req.query.userID;
    if (!/^\d+$/.test(String(userID))) {
      return res.status(400).json({ error: 'invalid_user' });
    }
    res.json({ token: makeToken(userID) });
  });
}

app.use(require('./routes/cooldowns'));
app.use(require('./routes/ads'));
app.use(require('./routes/claim'));

app.use(express.static(path.join(__dirname, '..', 'public')));

// 마지막 안전망. 상세 원인은 서버 로그에만 남기고 응답에는 노출하지 않는다.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  // 127.0.0.1에만 바인딩해서 같은 기계 밖에서는 접근하지 못하게 한다 (9-3장).
  app.listen(port, '127.0.0.1', () => {
    console.log(`listening on http://127.0.0.1:${port}`);
  });
}

module.exports = app;
