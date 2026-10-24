# reason.md - 왜 이렇게 했는가

작업이 하나 끝날 때마다 이 문서를 갱신한다. 기준은 REQUIREMENTS.md(스펙)와 claude.md(진행 규칙)다.

## M1: 프로젝트 뼈대, MySQL, 스키마

### 파일별 이유

| 파일 | 왜 이렇게 했는가 |
| --- | --- |
| package.json | 의존성은 스펙(12장)대로 express, mysql2만 둔다. 스크립트는 `node --env-file=.env`를 쓰기 때문에 Node 20.6 이상이 필요해 `engines`에 적었다. |
| docker-compose.yml | MySQL만 띄운다. `--default-time-zone=+00:00`으로 DB 시각을 UTC로 고정하고(3장), `db/`를 `/docker-entrypoint-initdb.d`에 마운트해서 첫 기동 때 schema.sql, seed.sql이 파일 이름 순서로 자동 적용된다. |
| db/schema.sql | 4-3장 DDL을 컬럼, 이름, 타입 하나 바꾸지 않고 옮겼다. 시각은 `DATETIME(3)`이고 UTC로 저장한다. `reward.impressionID`의 UNIQUE는 같은 광고로 두 번 적립되는 것을 DB가 마지막으로 막는 장치다. |
| db/seed.sql | 콘텐츠 2개(낚시, 출석체크)만 넣는다. 테스트 유저는 DB에 두지 않고 토큰의 userID만 쓴다. |
| .env.example | 비밀 값은 `change-me` 자리표시자다. 실제 `.env`는 복사해서 만들고 git에 올리지 않는다(9-3장). |
| .gitignore | `.env`와 `node_modules/`를 제외한다. AUTH_SECRET, ADMIN_TOKEN이 저장소에 올라가지 않게 한다. |
| PROGRESS.md | claude.md의 중단 대비 규칙. 토큰 리밋이나 세션이 끊겨도 어디까지 했는지 이어 볼 수 있다. |

### 판단한 점
- 스펙의 `reward-cooldown/` 루트를 저장소 루트(`/Users/hgoose/final`)로 해석했다. 하위 폴더가 필요하면 바꾼다.
- REQUIREMENTS.md와 claude.md는 커밋하지 않았다. 기준 문서이고 사용자가 관리한다.
- 로컬 `.env`는 `.env.example` 복사본이다 (`DB_PASSWORD=change-me`). 로컬 개발용이라 그대로 뒀다.

### 확인 결과 (완료 기준)
- `docker compose up` 후 `content` 2행, 테이블 5개, MySQL global/session time_zone `+00:00`.
- `npm install` 취약점 0건.
- 커밋 `a1fd138`.

### 단순화한 곳 (ponytail 주석 대상)
- 없음.

## M2: 다음 가능 시각 계산 (src/cooldown.js)

### 파일별 이유

| 파일 | 왜 이렇게 했는가 |
| --- | --- |
| test/cooldown.test.js | 구현보다 먼저 썼다(TDD). 스펙 10장의 C1~C6을 입력과 기대값 그대로 옮겼다. 기대값은 고치지 않았다. 구현 전에 돌려 `Cannot find module`로 실패하는 것을 확인했다. |
| src/cooldown.js | `computeNextAvailableAt(content, nowUtc)` 순수 함수. DB, 네트워크, 현재 시각을 읽지 않고 인자로만 받아서, 경계 값을 테스트로 정확히 고정할 수 있다. |

### 설계 이유 (cooldown.js 안 주석과 같은 내용)
- **interval:** `now + intervalSec × 1000ms`. 마지막 적립 시각이 곧 `now`라서 계산이 단순하다.
- **dailyReset의 한국 시간:** 서머타임이 없으므로 고정 +9시간으로 충분하다. UTC 밀리초에 9시간을 더한 '가짜 UTC'로 한국 날짜 00:00을 구한다.
- **엄격하게 큰(>) 비교:** 정확히 초기화 시각에 적립하면 그 시각이 아니라 다음 초기화 시각이 나온다(C3, C5). `>=`로 하면 방금 적립했는데 바로 또 가능해진다.
- **오늘, 내일 두 날만 본다:** 오늘 후보가 모두 지났으면 내일의 가장 이른 후보가 반드시 걸리기 때문이다.
- **후보 시각 정렬:** DB의 `resetTimesKST` 순서를 믿지 않고 이른 순으로 정렬해서 앞에서부터 찾는다.

### 확인 결과 (완료 기준)
- `npm test`: C1~C6 6개 통과, 실패 0.

### 단순화한 곳 (ponytail 주석 대상)
- 없음. 잘못된 `resetTimesKST` 형식(예: "25:99")은 검증하지 않는다. content는 seed로만 들어오는 값이라 스펙 범위 밖으로 두었다.

## M3: 서버, DB 풀, 토큰, GET /cooldowns, 홈 화면

### 파일별 이유

| 파일 | 왜 이렇게 했는가 |
| --- | --- |
| src/db.js | 커넥션 풀 하나. `timezone: 'Z'`로 DATETIME을 UTC로 읽고 쓴다(3장). 접속 정보는 환경 변수에서만 읽는다. |
| src/auth.js | `<userID>.<hex(HMAC-SHA256)>` 토큰 발급과 검증, `requireUser`, `requireAdmin`. userID를 서명된 토큰에서만 꺼내므로 클라이언트가 남의 userID를 쓸 수 없다(FR-11). |
| src/routes/cooldowns.js | 라우터는 인증과 응답만 하고, 조회는 `getCooldowns` 함수에 분리했다. SQL은 그 함수 안에 직접 썼다(claude.md 코드 구조). |
| src/server.js | `app`을 export하고 `require.main === module`일 때만 `127.0.0.1`에 listen한다(테스트가 임시 포트로 띄울 수 있게). `/dev/token`은 development일 때만 라우트를 등록한다. |
| public/app.js | 화면 공용 코드: 토큰 보관(주소의 `?token=`을 sessionStorage에 저장하고 주소에서 지움), API 호출, 한국 시간 `HH:mm`과 남은 시간 문구. |
| public/index.html | 큰 글씨 카드, ready 카드를 위에 두고 같은 그룹은 contentID 순. 카운트다운은 서버 시각 기준(아래). |

### 설계 이유
- **쿼리 한 번:** `content LEFT JOIN user_content_state`에 `UTC_TIMESTAMP(3)`를 같이 읽는다. LEFT JOIN이라 행이 없는 처음 상태도 나오고, '지금'이 DB 시각 하나로 통일된다(3장, 9-2장).
- **읽기 전용:** 행을 만들지 않는다. 확인: 조회 후 `user_content_state` 0행.
- **ready이면 nextAvailableAt은 null:** 저장된 시각이 이미 지났어도 null로 내려 준다(6-1).
- **카운트다운:** 응답의 `serverTime`을 기준점으로 잡고 흐른 시간은 `performance.now()` 차이로 센다. 기기 시계를 바꿔도 남은 시간이 안 변한다(FR-2). 0이 되면 `/cooldowns`를 다시 불러 서버가 ready일 때만 문구를 바꾸고, 아직 아니면 1초 간격으로 다시 조회한다. 탭이 다시 보일 때도 조회한다.
- **한국 시간 표시:** 기기 시간대에 의존하지 않도록 UTC에 9시간을 더해 `getUTC*`로 읽는다.
- **토큰 비교는 `timingSafeEqual`:** 스펙 13장은 "상수 시간 비교"를 알고도 뺀 것으로 적었지만, 몇 줄이라 넣었다. 13장의 해당 항목은 이제 사실과 다르다.

### M1에서 발견해 고친 버그 (스펙과 다른 점)
- **증상:** API 응답의 `name`이 `ë‚šì‹œ`처럼 깨졌다. 저장된 바이트가 UTF-8로 두 번 인코딩돼 있었다.
- **원인:** MySQL 초기화 스크립트(schema, seed)는 클라이언트 기본 문자셋(latin1)으로 읽힌다. M1에서는 행 수와 테이블만 확인해서 놓쳤다.
- **수정:** `db/seed.sql` 맨 위에 `SET NAMES utf8mb4;` 한 줄 추가(스펙의 seed에는 없는 줄). 볼륨을 지우고(`docker compose down -v`) 다시 띄워 `EB829AEC8B9C`(낚시)로 정상 저장됨을 확인했다.
- **판단:** 스펙을 어기는 변경이지만 한글 이름이 화면에 그대로 나오려면 필요한 최소 수정이라 멈추지 않고 고쳤다. 스펙 쪽 seed에 같은 줄을 넣는 것이 좋다.

### 확인 결과 (완료 기준)
- DB를 직접 고쳐 확인: 행 없음 → 둘 다 ready, 낚시 45분 뒤 → ready=false와 미래 시각, 지난 시각 → ready=true와 null, 다른 유저는 영향 없음, 토큰 없음과 위조 → 401.
- 브라우저(화면): 출석체크가 위, 낚시 "1시간 4분 뒤 (14:01)"(05:01Z = 한국 14:01). 6~10초 뒤로 고쳤을 때 "곧 가능" → 0이 되면 서버 재조회 → "지금 할 수 있어요"로 바뀌고 정렬됨.
- `npm test`: C1~C6 6개 통과.

### 단순화한 곳 (ponytail 주석 대상)
- `/dev/token`의 userID가 숫자가 아니면 400 `invalid_user`를 돌려준다. 이 코드는 스펙 6장에 없는 임의 값이다(개발용 엔드포인트라 형식이 정해져 있지 않았다).
- `getCooldowns`는 content가 0개인 경우를 처리하지 않는다(seed로 항상 2개). 주석으로 표시했다.
- 알림, 이벤트 전송, 콘텐츠 화면은 M5 범위라 넣지 않았다. 카드 링크 `content.html`은 M5 전까지 404다.
