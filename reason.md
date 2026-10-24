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
