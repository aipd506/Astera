# 다음 세션 이어하기 (2026-09-28 작성)

## 한 줄 요약
멈춤·느려짐 정리 1~4단계 코드는 **모두 develop 에 푸시, CI green**. 화면 검증 6항목도 2026-09-28 저녁에
**모두 통과**했고, 그 김에 한 앱 전체 보안 검토에서 확인된 취약점 4건을 고쳐 푸시했다(마지막 HEAD `1bf2449a`,
CI 36475184954 — ubuntu·macOS·Windows 모두 green). 2026-09-29 Windows 화면 검증도 했다("끝난 것 (3)"). 남은 것은
보안 검토의 "결정이 필요한 것"과 "그 밖에 남은 것"이다.

## 끝난 것 (develop, 모두 푸시·CI green)
| 단계 | 범위 | 원장 |
|---|---|---|
| 1단계 | PATH/cwd 비동기 프로브 풀, 작업 폴더 존재 캐시(ENOENT+부모 응답일 때만 삭제), 대화 기록 꼬리 창, git maxBuffer 64MB·unknown 구분·쓰기 10분 | `.superpowers/sdd/2026-09-27-stage1-freezes/progress.md` |
| 2단계 | 남은 동기 체크 제거·프로세스 전역 ProbeBudget, 탐색기 변경 묶음·로딩, 작업 폴더 만들기 단계·취소, 삭제·복사 진행, 새 세션/@색인/Python/시작 화면/업데이트 타임아웃, CLI "Host 응답 대기" | `.superpowers/sdd/2026-09-27-stage2/progress.md` |
| 3단계 | 저널 읽기 250ms·페이징·복구 판단 busy 재시도, Host 설치 비동기·"Host 준비 중", 로그 버퍼·5MB 회전, 상태 파일 압축·병합 저장·푸시 조절 | `.superpowers/sdd/2026-09-28-stage3/progress.md` |
| 4단계 | gateRoot/pastCap(사용자 작업은 한도 넘어 1회), 복구 git 사실 비동기, app js 실행 대기 최대 5분, Codex 기록 색인·창 읽기, 작업 추적 git 횟수 감소, 탐색기 가상화(화살표·Shift 선택 신설), CLI host start/stop 알림, 복구 패스 예산(바쁜 대기만 셈, 초과분은 다음 패스로 미룸) | `.superpowers/sdd/2026-09-28-stage4/progress.md` |

원장과 보고서는 `.superpowers/` 아래라 git 에 없고 이 PC 에만 있다. 각 원장에 "minor (deferred)" 줄로 미룬 작은 지적과 각 단계 `review-final.md` 가 있다.

## 끝난 것 (2): dev 앱 화면 검증 — 2026-09-28 저녁, 모두 통과
macOS 에서 production 빌드(`electron-vite preview`)를 새 프로필·고유 포트로 띄우고 CDP 로 DOM 을 조작해 확인했다.
계정은 빈 설정 폴더를 가짜 계정으로 등록해 썼다(실제 계정은 건드리지 않음). 이 PC 에는 원장·메모리가 없어
문서의 규칙만으로 진행했다.

| # | 항목 | 결과 |
|---|---|---|
| 1 | 탐색기 가상화 | 1만 파일에서 그려진 행 42~50개, 행 높이 22px, 빠른 스크롤 빈칸 없음, End·Home·↓, 먼 줄 F2, Shift+↓ 정상 |
| 2 | 삭제·복사 진행 | 행 스피너, "삭제하는 중… N개 항목", 5,000개 한도 안내, 3천 파일 복사 진행 표시 |
| 3 | 작업 폴더 만들기 | fetch → checkout → "129.4MB / 150.0MB" 복사 단계 표시, 도중 취소 시 브랜치·worktree·목록 모두 없음 |
| 4 | 새 세션 창 | "저장소를 확인하는 중…"/"CLI 를 확인하는 중…", 저장소 아니면 worktree 옵션 숨김 |
| 5 | 설정 스위치 | "에이전트 앱 작업 공간 (실험)" 기본 꺼짐, 켜면 저장 + 모든 계정에 astera-app 스킬 설치 |
| 6 | app js 미러 탭 | `astera app js` 로 띄운 앱이 보라색 테두리 탭에 보이고, 닫기로 프로세스가 모두 끝남 |

검증 중 찾아 고친 것(모두 develop): 새 프로필 첫 실행에서 `host.pid` 미기록(3단계 회귀) `0a2152fc`, dev 재시작 시
StrictMode 로 되찾은 세션이 빈 탭 `81f5e70f`, worktree 취소 뒤 빈 저장소 폴더 `78dc2f89`, macOS 단축키 표기·Cmd+⌫
삭제·번역 안 된 CWD_MISSING `d87481e8`. 이름 바꾸는 행 26px 과 ✕로만 닫히는 오류 알림은 의도된 동작이라 두었다.
Windows 경로 테스트(`hostorch`)가 macOS 에서 저장소 루트에 `D:/cfg` 를 실제로 쓰는 새는 곳이 있다(지우기만 함).

## 끝난 것 (3): Windows 화면 검증 (2026-09-29)
Windows 11(라이트 모드)에서 dev 앱(`electron-vite dev`)을 새 프로필·포트 9472 로 띄우고 CDP 로 DOM 을 조작했다.
가짜 계정은 빈 설정 폴더를 등록해 썼다. OS 폴더 선택 창은 내 PID 의 창만 UI Automation 으로 조작했다.

| # | 항목 | 결과 |
|---|---|---|
| 1 | 절대 경로로 띄우기(`0cabf199`) | 세션이 `C:\Users\...\.local\bin\claude.exe` 로 cmd.exe 없이 바로 뜬다. 저장소에 심은 `claude.cmd`·`git.cmd`·`gh.cmd`·`codex.cmd` 는 폴더 선택·CLI 확인·세션 시작·git 상태 어디서도 실행되지 않았다. 탐색기 git 표시도 정상 |
| 2 | 작업 폴더 만들기·취소·삭제 | 단계와 "26.0MB / 150.3MB · 파일 26 / 20151" 표시, 취소 0.4초 뒤 브랜치·폴더·worktree 흔적 없음, 원본 파일 2만 개와 heavy 150개 그대로. 화면의 삭제 버튼으로 세 개를 지웠고 원본은 그대로 |
| 3 | 시작 화면 테마(`fddb2433`) | Windows 는 시작 페이지 없이 앱을 바로 띄운다. 창을 `PrintWindow` 로 찍으면 앱이 그려질 때까지 4초 넘게 고른 테마 배경(`orion` `#1e1f22`)이다. 창이 생긴 직후 한 프레임(약 0.16초) `#f3f3f3` 이 찍혔는데, 창이 맨 앞이 아니어서 실제 화면에 보이는지는 가리지 못했다 |
| 4 | 탐색기 가상화 | 1만 파일에서 그려진 행 65~74개, 22px, 빠른 스크롤 빈칸 없음, End·Home·↓·Shift+↓, 먼 줄 F2 정상 |
| 5 | 삭제·복사 진행 표시 | 확인 창의 5,000개 한도 문구, "삭제하는 중… N개 항목", 행 스피너, "복사하는 중… N개 항목" 모두 보임. 속도 문제는 아래에서 고쳤다(6천 파일 삭제 1.8초, 3천 파일 복사 4.3초) |

검증 중 고친 것: 새 세션 창의 `mounted` 가 StrictMode 의 dev 전용 재마운트 뒤 false 로 남아 worktree 단계·복사량이
dev 앱에서 한 번도 안 보이던 것 `835afc63`(production 은 원래 정상, macOS 검증이 preview 빌드라 못 봤다).

확인하지 못한 것: 탐색기 "복사" 가 파일을 OS 클립보드에 올리지 못했다는 알림. 이 PC 에서는 앱 없이 같은
PowerShell 스크립트를 돌려도, 콘솔 창을 띄워도 WinForms(OLE) 클립보드 쓰기가 전부 "요청한 클립보드 작업을 수행하지
못했습니다" 로 실패했다(pwsh `Set-Clipboard` 는 성공). 앱이 아니라 이 PC 환경의 문제로 보이며, 다른 PC 에서 파일
복사 뒤 Windows 탐색기 붙여넣기를 한 번 확인할 것.

### 고친 것: Windows 에서 탐색기가 보는 폴더의 대량 삭제·복사가 매우 느렸다 (`13d551bd`, 사용자가 A 안 선택)
- 증상: 6천 파일 폴더 삭제가 초당 약 12개(약 8분), 3천 파일 복사가 25초에 1,102개, main CPU 132%.
- 원인(재현함): chokidar 5 가 파일마다 `fs.watch` 를 걸고, Windows 에서 파일 하나의 감시는 그 폴더 전체의 감시라서
  폴더가 클수록 제곱으로 느려졌다. 앱 없이 1,500개 3.5초, 3,000개 32초, 6,000개 290초(감시 없이는 0.16초).
- 고친 것: win32 에서는 탐색기 루트에 기본 재귀 감시 하나(`fileWatcher.ts`). 앱이 직접 하는 삭제·복사·다른 드라이브로
  이동·외부 붙여넣기 동안에는 그 감시를 닫고, 끝나면 건드린 경로의 지금 상태를 한 번 보낸다(`quietWhile`).
  Linux 는 chokidar 그대로(Node 의 재귀 감시가 node_modules 까지 훑는다), macOS 는 재지 않아 그대로다.
- dev 앱 실측: 6천 파일 삭제 1.8초, 3천 파일 복사 4.3초. 밖에서 생긴 변화(새 파일·폴더, 펼친 하위 폴더 안의 파일,
  밖에서 지운 폴더, 열린 파일의 수정·삭제, git 표시, git 으로 1만 파일 폴더를 지웠다 되살리기)는 0.1~0.6초 안에 보인다.
- 남은 한계: 앱이 대량 작업을 하는 몇 초 동안 다른 곳에서 밖에서 바뀐 것은 그 폴더에 다음 변화가 올 때까지 트리에
  안 보일 수 있다. macOS 에서도 chokidar 가 같은 문제를 내는지는 재 볼 것.

## 보안 검토 — 2026-09-28
앱 전체를 다섯 영역(Host 소켓·CLI / Electron main·IPC·업데이트 / Slack·계정·비밀값 / 작업공간·worktree·Run·git /
renderer·오케스트레이션·기록)으로 나눠 읽고, 후보 6건을 각각 따로 검증했다.

**고친 것 (실제 취약점, 확신도 8 이상):**
- `fc71133f`·`1bf2449a` 편집기 저장(`files.write`)이 저장소가 심은 `X.cmtmp` 심볼릭 링크를 따라 프로젝트 밖 파일을
  덮어씀 → 임시 파일을 무작위 이름 + `lstat` + `O_EXCL` 로, 폴더는 realpath 로 루트와 비교. Windows 는 `O_EXCL`
  로도 대상 없는 링크를 따라가므로 `lstat` 이 필요했다(CI 에서 측정).
- `0cabf199` Windows: `cmd.exe /c claude` 처럼 이름으로 띄우면 cmd.exe 가 작업 폴더(=저장소)에서 먼저 찾음(CWE-427).
  폴더를 고르는 순간 `checkCli` 가 저장소의 `claude.cmd` 를 실행했다 → `core/sessions/windowsExecutable.ts` 가
  PATH 의 절대 경로 항목에서만 찾아 `.exe` 는 직접, `.cmd` 는 `cmd.exe /d /c call "<절대경로>"` 로 띄움.
  `git`/`gh`/모델 목록/How It Works 도 같은 경로. 같은 커밋에서 `sessions create --prompt` 의 cmd.exe 문법
  (`"hi|calc.exe"` 가 Host 에서 실행됨)을 명령 계층과 Host 양쪽에서 거부(`LAUNCH_FORBIDDEN`, commands.ts 로 이동).
- `440f78e3` Linux `/tmp` 에서 다른 계정이 Host 소켓 폴더를 먼저 만들면 앱·CLI 가 그쪽에 붙어 환경변수·입력을 넘김 →
  Host 가 바인드 전에 하던 소유자·0700 검사를 `core/host/socketDir.ts` 로 빼서 앱(`client.ts`)·CLI(`connect.ts`)도
  연결 전에 검사. macOS 는 `os.tmpdir()` 이 사용자별 0700 이라 원래 해당 없음.

**거짓 양성으로 판정한 것(문서화된 설계):** 같은 OS 계정의 프로세스(에이전트 포함)가 `sessions send` 로 다른 터미널
세션의 권한 확인에 답할 수 있는 점, `chats answer` 의 "사람만" 검사가 `ASTERA_SESSION` 유무라 환경변수를 지우면
통과하는 점. 둘 다 `docs/cli.md` Security 절과 s2-s6 설계의 Known limits 에 명시돼 있고, 기본 권한 모드가 `yolo`
라 답할 확인 창 자체가 없다. `manual` 모드 + `Bash(astera:*)` 허용 목록 + 프롬프트 주입이 겹쳐야 위험하다.

**문제 없음으로 확인:** Slack 인바운드(memberId 검사), 토큰 로깅 없음, 훅·statusline 스크립트 고정 문자열, TLS 검증
유지, preload·webview 가드, `openExternal` 허용 목록, raw HTML 렌더링 없음, 기록 삭제·복원 경로 확인, SQLite
파라미터화, `.worktreeinclude` 경로·링크 처리, worktree 삭제 경계, git 인수 주입 없음, 에이전트 스크립트 격리 문구.

**고친 것 (2026-09-30, 사용자 결정: 여러 사람이 쓰는 Windows 도 지원):**
- Windows 명명 파이프 선점(Medium) `a422ca50`: Host 가 `<프로필>\host\host.key` 에 무작위 키를 두고, 앱·CLI 의
  hello `nonce` 에 HMAC `proof` 로 답한다(`core/host/hostKey.ts`). 증명이 없거나 틀리면 앱은 아무것도 보내지 않고
  정보 탭에 이유를 보이며 세션을 스스로 띄우고, CLI 는 `PERMISSION_DENIED`(5). `HOST_PROTOCOL` 3 → 4 라서 이
  업데이트 한 번은 프로토콜 3 Host 가 물러나며 그 터미널이 끝난다(사용자 동의). dev 앱에서 정상 경로와 선점 경로를
  모두 확인했다(가짜 파이프는 hello 말고 아무것도 받지 못함).
- 같은 날 Windows Host 실행 파일 이름을 `astera-host.exe` 로 바꿨다 `9cfe2c62`(바이트는 node.exe 그대로, 서명 유효).

**결정이 필요한 것:**
- (2026-09-29 반영) 위 두 설계 항목 중 `sessions send` 는 실수 방지 수준으로 좁혔다: 에이전트 세션에서 보낸
  send 가 권한 확인·질문 중인 터미널 세션을 향하면 아무것도 치지 않고 6 으로 거부하고 `sessions read` 를 안내한다
  (대화 세션 쪽 검사와 짝). 환경변수를 지우면 우회되므로 경계는 아니다. 진짜 경계가 필요하면 Host 가 소켓 상대의
  프로세스(`SO_PEERCRED`/`GetNamedPipeClientProcessId`)를 확인해야 한다 — 남은 결정.
- `hello` 의 `role` 은 인증이 아니라서 같은 계정의 프로세스가 `role:'app'` 으로 붙으면 `COORDINATOR_ONLY` 를 우회할
  수 있다(설계와 일치, 문서화됨). 워커를 가두는 보안 장치로 기대한다면 세션별 토큰이 필요하다.

## 그 밖에 남은 것 (사용자 결정·직접 확인 필요)
- 명세(headless CLI): Linux AppImage 실기기 확인, pipe ACL(지금처럼 두기로 결정), `sessions send --wait` 가 상태 모를 터미널에서의 한계, 앱의 proc-opened 인수 경로는 타입 검사만
- 대화창 화면 확인 2건(내가 띄운 앱에서는 불가 — 대화 세션은 로그인된 계정이 있어야 뜬다): 대화 세션 입력창의 `@`
  메뉴가 큰 저장소의 첫 색인 동안 스피너와 "파일 목록을 만드는 중…" 을 보이는지(`a247c9bd`), 닿지 않는 폴더에서
  "파일 목록을 가져올 수 없음" 으로 멈추는지(`0a8008d8`). 표시 문제뿐이라 릴리스를 막지 않는다.
- macOS 시작 화면은 2026-09-29 확인했다(3초 늦게 답하는 SHELL 래퍼 + CDP 스크린캐스트). 문구·스피너·정렬은 맞았지만
  라이트 모드 macOS 에서 흰 화면이었다가 어두운 앱으로 바뀌었다(앱 테마 7개가 모두 어둡다) → 시작 페이지와 창 배경이
  저장된 앱 테마를 쓰도록 고쳤다. 전환 중 흰 프레임은 없다. Linux 시작 화면은 아직 눈으로 보지 않았다.
- `feature/killer-demo-video` 브랜치 병합 여부, main 병합·릴리스(main 이 develop 보다 수백 커밋 뒤)
- macOS 권한 모드(선택 기능), 각 단계 원장의 deferred minors

## 작업 규칙 (이 저장소)
- 커밋 메시지 **영어**(2026-09-28 사용자 결정 — 이전에는 한국어), **Co-Authored-By·Claude-Session 트레일러 금지**, 경로로 커밋(`git commit -- <paths>`; 추적 해제 같은 삭제는 인덱스로 커밋해야 한다 — 경로 지정은 작업 트리의 파일을 다시 담는다), git stash 금지
- 병렬 에이전트는 공유 인덱스 주의(한 번 남의 스테이징을 쓸어간 사고). 반드시 `git commit -- <자기 경로>`
- develop CI 는 `gh workflow run ci.yml --ref develop`; 알려진 부하 흔들림 테스트: shuttle.nsis, scriptWorker, list.test, rolling.integration, claudeCoordinator, host/workspace/manager, worktrees/remove, integrateGit
