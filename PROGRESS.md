# PROGRESS

## 완료한 단계
- M1: package.json, docker-compose.yml, db/schema.sql, db/seed.sql, .env.example, .gitignore (main)
- M2: src/cooldown.js, test/cooldown.test.js (main에 머지됨)
- M3: src/db.js, src/auth.js, src/server.js, src/routes/cooldowns.js, public/app.js, public/index.html (main에 머지됨)
- M4: src/ads.js, src/routes/ads.js, src/routes/claim.js, test/claim.test.js (브랜치 m4-claim, PR 대기)
- M5: src/routes/events.js, public/content.html, 홈 이벤트·알림, A9·A10 (브랜치 m5-events-alarm, m4-claim 위에 쌓음)

- M6: src/metrics.js, src/routes/admin.js, test/metrics.test.js (브랜치 m6-metrics, m5-events-alarm 위에 쌓음)

- UI: 유저 화면 다듬기 (브랜치 ui-polish, 홈·콘텐츠 화면의 모양과 문구만 변경)

- 리뷰 반영: L-1, M-1, L-2, L-3, M-2, L-4와 테스트 공백, 발표용 주석 (브랜치 review-fixes)

- M7: 하루 한도 (브랜치 m7-daily-limit, 낚시 10회, 일요일 18시까지)

- M8: 방문 보너스 seed (브랜치 m8-bonus-seed, m7-daily-limit 위에 쌓음 - M7을 먼저 머지)

- M7 리뷰 후속 (브랜치 m7-review-fixes, m8-bonus-seed 위에 쌓음): 3 테스트 전용 ID 범위, 1 적립 응답의 다음 가능 시각이 한도를 반영, 2 한도 조건의 동시성 테스트 채택 4 남은 횟수 줄 undefined 방어 5 낡은 주석 4곳, 6·7은 한계로만 기록 (모두 완료)

- M9: 쿨타임 목록 페이지와 시연용 홈 (브랜치 m9-demo-home, main에서 분기). public/home.html(시연용 홈), public/cooldowns.html(목록), public/cooldown-view.js(공용 순수 함수와 알림 판정), content.html(돌아가기 링크와 색만), scripts/demo-reset.js와 npm run demo:reset, test/cooldown-list.test.js(16개), test/demo-reset.test.js(8개). index.html과 app.js는 수정하지 않았다(index.html은 개발용으로 남김). 새 API·DB·판정 변경 없음. REQUIREMENTS.md는 요청에 따라 7-5, M9 행, 13장 한 줄만 고쳤다(이 파일은 untracked라 커밋에 없다)

## 진행 중
- public/admin.html (선택, 우선순위 가장 낮음)
- 보존해 둔 브랜치(둘 다 M9 정정 전 작업): ui-home-app(홈 2열 카드 WIP 커밋, 푸시 안 함)와 m9-cooldown-list(index.html을 고치던 첫 M9, 푸시함). 둘 다 m9-demo-home이 대체한다. 지울지는 사용자가 정한다
- ECC 코드 리뷰·보안 리뷰는 M4를 마친 뒤, M6을 마친 뒤 사용자가 요청할 때만 돌린다 (claude.md)

## 마지막 테스트 결과
- M9: npm test 111개 통과(기존 87 + 목록·홈 함수 16 + demo-reset 8). 새 테스트는 구현 전에 모두 실패하는 것을 먼저 확인했다. 브라우저로 시연 순서 ①~⑤를 직접 확인: reset → 홈 진입 줄 "다음: 튜브 낚시", 출석체크 적립 뒤 칸이 04:22:10 시계로, 목록이 낚시·출석체크·방문 보너스 순, 낚시가 0이 되면 목록에서 빠져 "지금 할 수 있어요"로 이동(알림 1건), 홈 칸도 "참여 가능", 홈에서 0이 되는 경우도 알림 1건, 빈 상태
- M8: npm test 77개 통과(2회 반복). seed 변이 검증 통과. 브라우저로 홈 카드 3개와 설치형 광고 확인
- M7: npm test 75개 통과(2회 반복). 변이 검증 3건(SET 순서, FOR SHARE, WHERE 한도 조건)이 테스트에서 잡힘. 브라우저로 한도 남음/소진 확인
- 리뷰 반영: npm test 66개 통과(3회 반복). 변이 검증 3건이 새 테스트에서 잡힘
- UI: npm test 44개 통과. 글자 대비를 계산으로 확인(모두 4.5 이상). 브라우저로 홈·콘텐츠의 모든 상태를 직접 확인
- M6: npm test → 44개 통과(3회 반복). 변이 검증 3건이 테스트에서 잡힘. 실제 API 이벤트로 /admin/metrics 확인
- M5: npm test → 27개 통과 (C1~C6, 광고 5, A1~A12, 이벤트 수집 3). 브라우저로 콘텐츠 흐름, 토스트/브라우저 알림 한 번만 뜨는지 확인
- M4: 22개 통과, 변이 검증 2건(조건부 UPDATE 제거, FOR SHARE 제거)이 테스트에서 잡힘, A3/A4 5회 반복 통과

## 막힌 점
- 없음

## 의도적으로 단순화한 곳
- scripts/demo-reset.js는 시연 전용이다. NODE_ENV=development일 때만 동작하고 userID=1의 user_content_state 세 행만 바꾼다(낚시는 지금 + N초, 방문 보너스는 방금 적립, 출석체크는 행 삭제). 서비스 코드가 아니고 reason.md와 파일 맨 위 주석에 그렇게 적었다.
- 이모지(ICONS), 화면 이름("튜브 낚시"), 시계 앞의 말("다음 출석까지")은 contentID로 고정했다(cooldown-view.js). 모양만 정하는 값이고 새 콘텐츠는 서버 이름과 기본 ⭐이 나온다.
- 홈 격자의 순서는 출석체크, 튜브 낚시, 방문 보너스로 고정했다. 그 밖의 콘텐츠는 뒤에 contentID 순으로 붙는다.
- "방금 가능" 강조는 페이지를 새로 열면 사라진다(저장하지 않는다). 알림은 탭마다 따로 센다(홈과 목록을 다른 탭에 두면 한 번씩 뜰 수 있다).
- 파랑 #3B82F6는 흰 배경 위 큰 굵은 글씨와 버튼 바탕에만 썼다. 하늘색 배경 위 글씨와 작은 글씨는 같은 계열의 #2563EB로 대비를 맞췄다.
- 알려 둘 것: npm test의 claim.test.js는 매번 user_content_state, event_log, reward, ad_impression을 비운다(10장의 기존 규칙). 시연 직전에는 npm run demo:reset을 다시 실행한다.

## 메모
- 스펙의 reward-cooldown/ 루트는 저장소 루트(/Users/hgoose/final)로 해석함
- 로컬 .env는 .env.example 복사본 (DB_PASSWORD=change-me)
- 작업 사이클: 단계마다 브랜치 → 커밋 → 푸시 → 복붙용 PR 내용. 테스트 통과 시 멈추지 않고 다음 단계로 진행
- 다음 브랜치는 이전 단계 브랜치 위에서 만든다 (PR 머지를 기다리지 않기 위함)
- M1 seed의 한글 깨짐을 M3에서 고침: db/seed.sql에 SET NAMES utf8mb4 추가, 볼륨 재생성 (reason.md 참고)
- M6의 metrics 테스트가 DB를 쓰면 claim.test.js와 병렬 실행으로 충돌할 수 있다. DB를 쓰는 테스트가 둘 이상이 되면 --test-concurrency=1을 검토한다
