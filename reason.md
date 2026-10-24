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
