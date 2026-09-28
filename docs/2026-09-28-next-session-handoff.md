# 다음 세션 이어하기 (2026-09-28 작성)

## 한 줄 요약
멈춤·느려짐 정리 1~4단계 코드는 **모두 develop 에 푸시, CI green** (마지막 HEAD `3e1734e6`, CI 36363360854).
남은 것은 **dev 앱 화면 검증**(중간에 사용자가 중지)과 그 뒤의 정리·릴리스 결정뿐이다.

## 끝난 것 (develop, 모두 푸시·CI green)
| 단계 | 범위 | 원장 |
|---|---|---|
| 1단계 | PATH/cwd 비동기 프로브 풀, 작업 폴더 존재 캐시(ENOENT+부모 응답일 때만 삭제), 대화 기록 꼬리 창, git maxBuffer 64MB·unknown 구분·쓰기 10분 | `.superpowers/sdd/2026-09-27-stage1-freezes/progress.md` |
| 2단계 | 남은 동기 체크 제거·프로세스 전역 ProbeBudget, 탐색기 변경 묶음·로딩, 작업 폴더 만들기 단계·취소, 삭제·복사 진행, 새 세션/@색인/Python/시작 화면/업데이트 타임아웃, CLI "Host 응답 대기" | `.superpowers/sdd/2026-09-27-stage2/progress.md` |
| 3단계 | 저널 읽기 250ms·페이징·복구 판단 busy 재시도, Host 설치 비동기·"Host 준비 중", 로그 버퍼·5MB 회전, 상태 파일 압축·병합 저장·푸시 조절 | `.superpowers/sdd/2026-09-28-stage3/progress.md` |
| 4단계 | gateRoot/pastCap(사용자 작업은 한도 넘어 1회), 복구 git 사실 비동기, app js 실행 대기 최대 5분, Codex 기록 색인·창 읽기, 작업 추적 git 횟수 감소, 탐색기 가상화(화살표·Shift 선택 신설), CLI host start/stop 알림, 복구 패스 예산(바쁜 대기만 셈, 초과분은 다음 패스로 미룸) | `.superpowers/sdd/2026-09-28-stage4/progress.md` |

원장과 보고서는 `.superpowers/` 아래라 git 에 없고 이 PC 에만 있다. 각 원장에 "minor (deferred)" 줄로 미룬 작은 지적과 각 단계 `review-final.md` 가 있다.

## 중지된 것: dev 앱 화면 검증
- 검증 에이전트를 사용자 요청으로 중지했다. **보고서(verify-report.md)는 쓰이지 않았고 항목별 결과는 알 수 없다.**
  작업 흔적상 6번(app js 미러)까지 진행 중이었던 것으로 보인다(`verify-9471/app*.js`).
- 검증용 dev 앱(포트 9471)과 그 Host·데스크·app js 창은 2026-09-28 에 PID 로 하나씩 모두 종료했다. 다음 검증은 새 프로필로 새로 띄운다.
- 스크래치: `.../scratchpad/verify-9471/` (1만 파일 폴더, 150MB 저장소 bigrepo, 픽스처 등). 재사용하거나 지운다.

### 다음 세션에서 할 검증 (우선순위, 실제 DOM 조작 + 스크린샷)
절차는 메모리 `astera-dev-run-cdp`, `app-verification-process-isolation`, `verify-on-screen` 를 따른다
(새 --user-data-dir, 고유 포트, ASTERA_*/CLAUDE_*/CODEX_*/CLAUDECODE 비우기, 계정 등록 금지, 끝나면 dev 앱은 켜두기).
1. 탐색기 가상화: 1만 파일 폴더에서 그려진 행 수, 빠른 스크롤, 화살표·Home·End, 먼 줄에서 F2, Shift+↓, 행 높이(19→22px)
2. 삭제·복사 진행: 6천 파일 폴더 삭제 시 행 스피너·"삭제하는 중… N개 항목"·5,000개 한도 안내, 수천 파일 복사 진행
3. 작업 폴더 만들기: 150MB 포함 복사 중 단계·복사량 표시, 도중 취소 후 폴더·브랜치·목록이 남지 않는지
4. 새 세션 창: "저장소 확인 중…"/"CLI 확인 중…", 저장소 아님/폴더 없음 안내, 작업 폴더 옵션
5. 설정: "에이전트 앱 작업공간(실험적)" 스위치와 문구
6. (가능하면) app js 미러 탭. 계정이 필요하면 "막힘"으로 보고
검증에서 버그가 나오면 고치고 CI 한 번.

## 그 밖에 남은 것 (사용자 결정·직접 확인 필요)
- 명세(headless CLI): Linux AppImage 실기기 확인, pipe ACL(지금처럼 두기로 결정), `sessions send --wait` 가 상태 모를 터미널에서의 한계, 앱의 proc-opened 인수 경로는 타입 검사만
- 대화창 화면 확인 2건(내가 띄운 앱에서는 불가), macOS/Linux 시작 화면 눈 확인
- `feature/killer-demo-video` 브랜치 병합 여부, main 병합·릴리스(main 이 develop 보다 수백 커밋 뒤)
- macOS 권한 모드(선택 기능), 각 단계 원장의 deferred minors

## 작업 규칙 (이 저장소)
- 커밋 메시지 한국어, **Co-Authored-By·Claude-Session 트레일러 금지**, 경로로 커밋(`git commit -- <paths>`), git stash 금지
- 병렬 에이전트는 공유 인덱스 주의(한 번 남의 스테이징을 쓸어간 사고). 반드시 `git commit -- <자기 경로>`
- develop CI 는 `gh workflow run ci.yml --ref develop`; 알려진 부하 흔들림 테스트: shuttle.nsis, scriptWorker, list.test, rolling.integration, claudeCoordinator, host/workspace/manager, worktrees/remove, integrateGit
