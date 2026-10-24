# PROGRESS

## 완료한 단계
- M1: package.json, docker-compose.yml, db/schema.sql, db/seed.sql, .env.example, .gitignore (main)
- M2: src/cooldown.js, test/cooldown.test.js (main에 머지됨)
- M3: src/db.js, src/auth.js, src/server.js, src/routes/cooldowns.js, public/app.js, public/index.html (main에 머지됨)
- M4: src/ads.js, src/routes/ads.js, src/routes/claim.js, test/claim.test.js (브랜치 m4-claim, PR 대기)
- M5: src/routes/events.js, public/content.html, 홈 이벤트·알림, A9·A10 (브랜치 m5-events-alarm, m4-claim 위에 쌓음)

- M6: src/metrics.js, src/routes/admin.js, test/metrics.test.js (브랜치 m6-metrics, m5-events-alarm 위에 쌓음)

## 진행 중
- public/admin.html (선택, 우선순위 가장 낮음)
- ECC 코드 리뷰·보안 리뷰는 M4를 마친 뒤, M6을 마친 뒤 사용자가 요청할 때만 돌린다 (claude.md)

## 마지막 테스트 결과
- M6: npm test → 44개 통과(3회 반복). 변이 검증 3건이 테스트에서 잡힘. 실제 API 이벤트로 /admin/metrics 확인
- M5: npm test → 27개 통과 (C1~C6, 광고 5, A1~A12, 이벤트 수집 3). 브라우저로 콘텐츠 흐름, 토스트/브라우저 알림 한 번만 뜨는지 확인
- M4: 22개 통과, 변이 검증 2건(조건부 UPDATE 제거, FOR SHARE 제거)이 테스트에서 잡힘, A3/A4 5회 반복 통과

## 막힌 점
- 없음

## 메모
- 스펙의 reward-cooldown/ 루트는 저장소 루트(/Users/hgoose/final)로 해석함
- 로컬 .env는 .env.example 복사본 (DB_PASSWORD=change-me)
- 작업 사이클: 단계마다 브랜치 → 커밋 → 푸시 → 복붙용 PR 내용. 테스트 통과 시 멈추지 않고 다음 단계로 진행
- 다음 브랜치는 이전 단계 브랜치 위에서 만든다 (PR 머지를 기다리지 않기 위함)
- M1 seed의 한글 깨짐을 M3에서 고침: db/seed.sql에 SET NAMES utf8mb4 추가, 볼륨 재생성 (reason.md 참고)
- M6의 metrics 테스트가 DB를 쓰면 claim.test.js와 병렬 실행으로 충돌할 수 있다. DB를 쓰는 테스트가 둘 이상이 되면 --test-concurrency=1을 검토한다
