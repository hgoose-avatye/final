# PROGRESS

## 완료한 단계
- M1: package.json, docker-compose.yml, db/schema.sql, db/seed.sql, .env.example, .gitignore (main에 푸시됨)
- M2: src/cooldown.js, test/cooldown.test.js (브랜치 m2-cooldown)

## 진행 중
- M3 대기: src/server.js, src/db.js, src/auth.js, GET /cooldowns, public/index.html

## 마지막 테스트 결과
- M2: npm test → C1~C6 6개 통과, 실패 0

## 막힌 점
- 없음

## 메모
- 스펙의 reward-cooldown/ 루트는 저장소 루트(/Users/hgoose/final)로 해석함
- 로컬 .env는 .env.example 복사본 (DB_PASSWORD=change-me)
- 작업 사이클: 단계마다 브랜치 → 커밋 → 푸시 → 복붙용 PR 내용. 테스트 통과 시 멈추지 않고 다음 단계로 진행 (claude.md 수정 반영)
- 다음 브랜치는 이전 단계 브랜치 위에서 만든다 (PR이 머지되기를 기다리지 않기 위함)
