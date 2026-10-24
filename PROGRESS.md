# PROGRESS

## 완료한 단계
- M1: package.json, docker-compose.yml, db/schema.sql, db/seed.sql, .env.example, .gitignore (main에 푸시됨)
- M2: src/cooldown.js, test/cooldown.test.js (main에 머지됨)
- M3: src/db.js, src/auth.js, src/server.js, src/routes/cooldowns.js, public/app.js, public/index.html (브랜치 m3-cooldowns-home, main에 머지됨)

## 진행 중
- M5 대기: /events, 홈과 콘텐츠 화면의 이벤트 전송, 알림(7-2), public/content.html (A9, A10 포함)
- ECC 코드 리뷰·보안 리뷰는 M4를 마친 뒤 사용자가 요청할 때만 돌린다 (claude.md)
- M4: src/ads.js, src/routes/ads.js, src/routes/claim.js, test/claim.test.js (브랜치 m4-claim)

## 마지막 테스트 결과
- M2: npm test → C1~C6 6개 통과, 실패 0
- M4: npm test → 22개 통과 (C1~C6, 광고 5, A1~A8, A11, A12). 변이 검증 2건과 A3/A4 5회 반복 통과
- M3: DB를 고쳐 가며 GET /cooldowns 확인, 브라우저로 홈 화면과 카운트다운 확인, npm test 6개 통과

## 막힌 점
- 없음

## 메모
- 스펙의 reward-cooldown/ 루트는 저장소 루트(/Users/hgoose/final)로 해석함
- 로컬 .env는 .env.example 복사본 (DB_PASSWORD=change-me)
- 작업 사이클: 단계마다 브랜치 → 커밋 → 푸시 → 복붙용 PR 내용. 테스트 통과 시 멈추지 않고 다음 단계로 진행 (claude.md 수정 반영)
- 다음 브랜치는 이전 단계 브랜치 위에서 만든다 (PR이 머지되기를 기다리지 않기 위함)
- M1 seed의 한글 깨짐을 M3에서 고침: db/seed.sql에 SET NAMES utf8mb4 추가, 볼륨 재생성 (reason.md 참고)
