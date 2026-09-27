# Agent workspace isolation, design brief

Status: **shipped for Windows, Linux and macOS** (2026-09-27). The designs are
[docs/superpowers/specs/2026-09-27-agent-workspace-isolation-design.md](superpowers/specs/2026-09-27-agent-workspace-isolation-design.md)
and, for the other two platforms,
[docs/superpowers/specs/2026-09-27-agent-workspace-linux-macos-design.md](superpowers/specs/2026-09-27-agent-workspace-linux-macos-design.md);
what shipped is summarised under the two "Shipped" sections below. The rest of this brief is the
problem and the measurements the design stands on, kept as they were written.

## Shipped (Linux and macOS, 2026-09-27)

The script API, `WorkspaceManager`, the mirror tab and every lifecycle rule are the Windows ones. Only
the `Desk` changes, chosen per platform by `workspaceDeskStarter` (`src/host/workspace/platformDesk.ts`),
and the Host announces `workspace` on all three.

- **Linux** (`src/host/workspace/deskLinux.ts`). Each workspace gets its own Xvfb display, from `:90`
  up, at 1920x1080. The app starts through `sh` in a process group of its own, with `DISPLAY` set,
  `WAYLAND_DISPLAY` and `WAYLAND_SOCKET` removed, and `XDG_SESSION_TYPE=x11`, `GDK_BACKEND=x11`,
  `QT_QPA_PLATFORM=xcb`, `SDL_VIDEODRIVER=x11` and `ELECTRON_OZONE_PLATFORM_HINT=x11` set (a newer
  Electron no longer reads that last hint alone, so Chromium, GTK, Qt and SDL are each pointed at X11
  directly). `DBUS_SESSION_BUS_ADDRESS` is removed too, and `XDG_RUNTIME_DIR` points at a folder of
  the desk's own (`astera-xrt-` and a random suffix under the temp folder, mode 0700), removed when the
  desk closes or its Xvfb exits. The person's session bus, portals, notifications, tray, `wayland-0` and
  audio sockets all live on that bus or in their runtime folder, so the app reaches none of them. The
  tools the desk runs get the same environment. `windows()` and `keys()` use xdotool, `windowShot()` and the frames without CDP use
  ImageMagick's `import`. It needs no signed in desktop, so it runs over SSH, in CI and on a server.
  `app js` is refused, with the install line for the distribution, when Xvfb, xdotool or `import` is
  missing.
- **macOS** (`src/host/workspace/deskMac.ts`). Nothing is created. The app starts in the person's
  session in the background, in a process group of its own: an app bundle is opened with `open -g -j -n`
  and a tag (`--astera-desk=<name>-<seq>`) unique to that launch in its arguments, found afterward with
  `ps`; a plain command runs through `sh` instead. Both get `ASTERA_APP_CHROMIUM_FLAGS`, holding the
  switches that keep a page nobody sees rendering, so a project's app can read it and start with
  `show: false`. The window is never moved, so it may sit behind the person's own (user decision L3b).
  Only the page is driven. `windows()`, `windowShot()` and `keys()` are refused with the reason, and
  `app js` is refused over SSH.
- **Kill and leftovers** (`src/host/workspace/posixProc.ts`). A start time is read from `/proc` on
  Linux and from `ps -o lstart=` on macOS, the same way when a launch is recorded and when it is
  checked, with the same 2 s tolerance. A match ends the process group with `SIGTERM`, then `SIGKILL`
  after 2 s. `workspaces.json` records the Xvfb pid as the helper on Linux, and only the launched app on
  macOS.
- **How it is tested.** Each Desk is unit tested with injected processes and files on every platform.
  The real e2e (`desktop.linux.e2e.test.ts`, `desktop.mac.e2e.test.ts`) runs in CI on the ubuntu and
  macos jobs with `ASTERA_DESKTOP_E2E=1`, after the ubuntu job installs `xvfb xdotool imagemagick`.

Rulings the plan made where the Linux and macOS spec was silent:

- **L-R1. Linux keys focus the window and use XTEST.** `xdotool --window` sends synthetic events, which
  Chromium ignores. The display is the workspace's own, so focusing on it takes nothing from anyone.
- **L-R2. `windowShot()` with no title photographs the largest titled window**, as on Windows, and the
  whole display only when no window has a title.
- **L-R3. `className` is empty on Linux.** `hwnd` is the X window id.
- **L-R4. Display numbers are reserved inside the Host**, so two workspaces starting at once get two
  displays; an Xvfb that exits before it is ready (another Host took the number) is retried on the next
  one, three times at most.
- **L-R5. macOS never moves a window.** That needs Accessibility, which is not asked for. An app that
  reads `ASTERA_APP_CHROMIUM_FLAGS` can keep its window hidden; the e2e fixture does.
- **L-R6. A macOS app bundle** is found by a tag (`--astera-desk=<name>-<seq>`) unique to that launch,
  added to its arguments and matched afterward with `ps` among the processes that started since `open`
  ran, never by path and time alone (an earlier instance, or the person's own, could match that). It
  sees only what reaches it after its path, not the launch environment.
- **L-R7. The Linux tool check runs on every `app js`**, so a tool installed while the Host runs counts
  at once. A check that fails is logged and refuses nothing.
- **L-R8. The feature is announced on all three platforms**, tools or not; the refusal explains, and
  checks the platform and SSH first, the setting next, and the Linux tools last, so a Host with the
  workspace off never names tools to install for a feature it would refuse anyway.

Known limits, beside the spec's:

- **macOS:** a Dock icon can appear while the app runs, and native windows, dialogs and keys cannot be
  driven. A plain command's window can show unless the app keeps it hidden, and an app that ignores the
  hide marker and shows its window anyway can come to the front. A bundle is found by the tag in its
  arguments, not by its path, so a bundle that App Translocation (macOS's own quarantine of a bundle
  opened from certain folders) runs from another path should still be found; that case has not been
  tested. A Screen Recording and Accessibility permission mode may come later, as an
  opt-in, to move a window or drive native input (user decision L3a).
- **Linux:** an app that only speaks Wayland cannot start on Xvfb; Electron apps use X11 through the
  hint. The clipboard is Xvfb's own, so `paste()` pastes only what the app itself copied. The app has
  no session bus and no secret service: an app that keeps secrets with Electron's `safeStorage` gets its
  `basic_text` backend there, not the person's keyring, and a file chooser opens as the toolkit's own
  dialog on the virtual display, never as a portal. Where `dbus-launch` is installed, libdbus may start
  a bus of its own for the virtual display; that bus is not the person's, and as a daemon it leaves the
  process group (see Both). A stale X lock file only makes the reservation skip that display number; it
  removes nothing.
- **Both:** a process that leaves its process group (a `setsid`, a daemon) escapes the group kill, as a
  process that detaches from the tree does on Windows. The command runs as `sh -c`, then a newline, then
  `wait`, so a child put in the background is still there to end. A blank line sits between them, so a
  command ending in a backslash continues onto that empty line and still reaches `wait`. A command with
  an unclosed heredoc, or one that calls `exit`, defeats that `wait`, and such a child may not be
  cleaned up.

## Shipped (Windows, 2026-09-27)

An agent session runs `astera app js --file check.js`. The Host answers it whether or not the Astera
app is open. The first `launch()` in a session creates a Windows desktop object nobody switches to,
starts the project's app there (a Run configuration or a command), and connects to the app's debugging
port. The script drives the page over CDP (`snapshot`, `click`, `fill`, `press`, `paste`, `drag`,
`dropFiles`, `screenshot`) and the native windows through the desktop helper (`windows`, `windowShot`,
`keys`). The person's screen, foreground window and pointer are never touched; the clipboard is shared.

- **Where it lives.** `src/core/workspace/` (the JSON line protocol, the idle and leftover rules, the
  script gate, and the helpers over the `Cdp` and `Desk` ports, none of it Windows specific) and
  `src/host/workspace/` (the PowerShell desktop helper with its embedded C#, the CDP client, the worker
  each script runs in, and `WorkspaceManager`). The app shows a mirror tab per session
  (`AppMirrorPane`), in the agent's violet, with the running helper, a Stop and a Close.
- **What the agent is told.** `resources/skills/app-guide.md`, printed by `astera app help`, and the
  `astera-app` skill, installed while **Agent app workspace** is on in Settings.
- **Lifecycle.** One desktop per session, cleaned up on `close()`, on Close in the tab, when the
  session ends, after 10 minutes without a script, and when the Host leaves. A Host that starts after
  one that died ends the recorded processes whose start time still matches
  (`<profile>/orch/workspaces.json`). Ending the helper does not by itself end the apps on its desktop
  (measured); the manager's own cleanup and the next Host's leftover sweep end them by pid and start
  time.
- **How it is tested.** Unit tests with fake ports for every helper and rule; a real Host server and
  orch for `app js` with no app attached and for the mirror events; and a real desktop e2e
  (`src/host/workspace/desktop.e2e.test.ts`, run with `ASTERA_DESKTOP_E2E=1` on a signed in Windows
  desktop) that launches an Electron fixture, drives it, and checks that the foreground window is the
  same before and after and that nothing is left running.

Rulings the implementation plan made where the spec was silent, adjusted below where the real desktop
changed one of them:

- **P1. The script deadline and the launch wait.** The script stays at 60 s. `launch()` waits
  `min(waitMs, time left in the script minus 2 s)` for the debugging port, so a port that never opens is
  reported by `launch` with the `--remote-debugging-port` hint rather than as `at: "timeout"`. It then
  waits up to 10 s more (`PAGE_READY_MS`) for the page to finish parsing past `about:blank`, and still
  succeeds if the page never settles by then, since the page helpers speak for themselves after that.
- **P2. Where `app js` is answered.** Above the command layer and below the request receipt line beside
  `requests-show`, because the CLI mints a request id for every call and a command above the line refuses
  one. A retried id replays the recorded result instead of launching twice.
- **P3. Its own setting.** `agentAppEnabled` in `app-settings.json`, labelled **Agent app workspace
  (experimental)** under Settings, Agents, off by default. It gates the `astera-app` skill and `app js`
  alike, and the Host reads it on every `app js`, so it works with the app closed.
- **P4. The session's folder.** Captures go to the folder every session is granted (`preview/shots`),
  named `app-<uuid>.png`, and are trimmed the way the agent browser's are.
- **P5. Embedded as a string.** The desktop helper script is a constant in the Host, ASCII only, written
  to `<profile>/host/desk-<hash>.ps1` at first use (rewritten only when it differs) and run with
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, because an encoded command
  would pass the command line limit.
- **P6. The app's opt in.** The Host pushes workspace events only to an app whose hello yields
  `workspace`, and captures frames only while one is attached.
- **P7. The mirror tab.** One workbench tab per session, placed in the background on the first event that
  opens a workspace, drawn only while the workspace is active. A workspace that closes leaves the tab
  showing closed until the person closes it.
- **P8. When the session ends.** A session ends, for its workspace, 5 s after its last pty or line process
  exits, because a roll reopens the same session id.
- **P9. Driving an app is not browsing the web.** `click` follows links, since the page is the app under
  test, and `press` sends trusted CDP key events rather than the agent browser's synthetic ones.
- **P10. No interactive desktop.** `app js` is refused, before any process starts, on a platform the
  workspace does not run on, over SSH on Windows and macOS (the Host's own environment says so), and in
  a non-interactive session (a window station that is not visible; the helper says so). **Adjusted:**
  the desktop helper cannot attach PowerShell's own thread to the desktop, since that fails with
  `ERROR_BUSY` (measured); it attaches a fresh thread for each window, capture or key request
  instead (`OnDesk`), and replies with whichever message is innermost. The spec left "its own thread"
  open as an implementation detail; this costs one thread per request, which is cheap. Linux refuses
  only for a missing tool (the Linux and macOS section above).
- **P11. What is recorded for leftovers.** `workspaces.json` holds, per workspace, the launched root pid
  and the helper pid, each with its creation time. At Host start, and by `relaunch()` for the app it ends,
  a recorded pid is only ended when the live process's creation time is still within 2 s of the recorded
  one; a malformed file kills nothing. **Adjusted:** ending the helper does not by itself end the apps on
  its desktop (measured), so this same pid and start time check, run by the manager's own cleanup and by
  the next Host's leftover sweep, is what ends them, not the helper's own exit.
- **P12. Frames.** JPEG, at most 960 px wide, about one a second while a script runs and an app yields
  `workspace`, plus one capture after each helper that changes the screen, coalesced while one is in
  flight; only the latest frame is kept.
- **P13. Each script in a worker of its own (amended 2026-09-27).** The Host runs every `app js` script
  in a worker thread, with the helpers left on its own thread behind the same gate, and ends the worker at
  the 60 second deadline or on Stop. A busy loop, before or after an `await`, is cut off and no longer
  freezes the Host or any session's terminal (`src/host/workspace/scriptWorker.ts`).
- **P14. Each script in a process of its own (amended 2026-09-27).** The Host starts one child process
  per `app js` script, from its own runtime with an environment built from nothing, and the worker of P13
  runs inside it with its heap limited to 256 MB. The child ends itself when its memory passes 512 MB,
  which counts ArrayBuffer and TypedArray memory the heap limit does not see, and the script reports
  `at: "memory"`. A child that dies any other way reports `at: "crashed"`. The deadline, Stop, Close,
  the session ending and the Host's orderly exit all end the child's process tree. If the Host crashes,
  the child sees its channel close and ends itself, but a process the script started is not ended with
  it. Memory a script takes can no longer take the Host down.

Two more limits, found only once a real desktop and a real helper were driven (Task 3, Task 10):

- **Every desk request times out at 15 s.** A launch, a capture, a windows list or a key press that gets
  no answer in that time ends the helper, since a hung window must not block every later call.
- **A process that detaches from the launched tree can escape cleanup.** The manager and the leftover
  sweep both walk the tree by pid and start time; a process that forks off and reparents itself is not
  found that way.

Known limits, beside the spec's:

- **The clipboard is shared**, so `paste()` reads what the person copied, and your app can overwrite
  what they copied.
- **Dragging out of the app to Explorer or another app is impossible.** This desktop has no real
  pointer, so an OS level drag never starts; `dropFiles()` proves the drop side only.
- **A closed mirror tab reappears when the Host reconnects while that workspace is still open.** The
  Close in the app ends the tab, not the workspace; a workspace the Host still holds is shown again once
  the app reconnects.
- **A script is ended at 512 MB of memory.** It runs in a process of its own (P14), so running out of
  memory ends that process and reports `at: "memory"`; the Host and every other session keep running.
- An Electron app that is not started with a debugging port gets the native helpers only.
  `snapshot().url` is empty for an address that is not http or https (a `file:` or custom scheme page).

**Linux and macOS** shipped next, in the section above.

## The problem

When an agent verifies GUI work it has to drive real windows, and today those windows are the
person's own screen. During one verification session on 2026-09-08 the agent:

- launched a second dev app window and raised it to the top of the person's desktop,
- opened Explorer windows, moved them and made them topmost,
- moved the mouse pointer and pressed and dragged with it,
- pressed a real Ctrl+V,
- overwrote whatever the person had on the clipboard.

Each of those is necessary to prove that an OS integration works. All of them are unacceptable while
someone is sitting at the machine, and they happen every time an agent has to launch an app, open a
file manager window and drag something in the space the person is working in.

The comparison they drew is the agent browser: rather than driving the person's browser, the app
gives the agent a surface of its own that it drives programmatically. The question is whether the
same can be done for "a running app plus the OS around it".

## What was measured (2026-09-08, Windows 11, Electron 41)

These constrain every design below. They were measured, not read.

- **A second app instance is already isolated.** `--user-data-dir=<tmp>` makes
  `requestSingleInstanceLock` take a different lock, so an agent's instance runs beside the person's
  without either noticing, and neither has to be closed first.
- **Most driving does not need the screen at all.** The context-menu paste verification passed with
  the app window behind other windows and `document.hasFocus() === false`, driven only by CDP
  `Runtime.evaluate` and DOM clicks. Screenshots come from `Page.captureScreenshot`, which does not
  need a visible window.
- **Only OS-level integration needed real input.** Of the whole session, exactly two steps did:
  Ctrl+V arriving as a real paste event, and a drag that Explorer would accept. CDP
  `Input.dispatchKeyEvent` takes a `commands: ['paste']` array which is likely to cover the first;
  it was not tried.
- **A background process cannot take the foreground.** `SetForegroundWindow` from a background
  process is refused; a synthetic *click* grants foreground rights. So any design that uses real
  input on the shared desktop necessarily steals focus.
- **Windows: a desktop object isolates windows and input; it does not isolate the clipboard.**
  Windows created on another desktop (`CreateDesktop`, `STARTUPINFO.lpDesktop` — the mechanism
  Sysinternals Desktops uses) are invisible on the person's desktop, and `SendInput` from a process
  attached to it lands only there. The clipboard belongs to the *window station* above it, and every
  desktop in `WinSta0` shares one. A separate window station would isolate the clipboard but
  interactive GUI apps generally do not run on one.
- Full clipboard isolation therefore means a second logon session or a VM.

## What the agent browser already does

`src/main/agentBrowser/`, `src/core/agentBrowser/`, `src/renderer/src/components/BrowserPane.tsx`.
The pattern worth copying: the agent gets a surface the app owns, a small scripted API instead of
raw input, a visible marker while it is driving (the violet frame and pointer), and an Escape that
gives control back. The isolation there is not an OS mechanism — it is that the agent never touches
the person's browser, only the app's own view.

## Candidate shapes

**A. Procedure only (no product change).** Codify: always `--user-data-dir`, always `show: false` or
off-screen, drive with CDP, never touch the real pointer. Costs nothing, ships today, and covers
everything except OS integration. Does not help agents working in the person's own projects.

**B. An agent verification instance inside astera.** The app launches the project's app for the
agent — hidden window, own profile, debug port — and exposes it through a scripted API the way the
agent browser exposes a page. The agent asks for clicks and screenshots; it never gets the mouse.
This is the direct analogue of the agent browser, and the `run` skill already knows how to start a
project's app, so the launch half exists in some form.

**C. A separate Windows desktop for agent GUI work.** The app creates a desktop object and launches
the agent's app (and any helper like `explorer.exe`) on it. Real input works there and lands nowhere
else. This is the only shape that covers drag-and-drop and other real-input integrations without
touching the person's screen. Windows-only, needs native calls (`CreateDesktop`,
`CreateProcess` with `lpDesktop`, and a capture path for that desktop), and still shares the
clipboard.

B and C compose: B for everyday UI verification, C only for the integrations that need real input.

## What the isolated-desktop spike measured (2026-09-08, Windows 11, Electron 41)

A throwaway spike created a desktop with `CreateDesktop`, launched apps on it through
`STARTUPINFO.lpDesktop`, and drove them from outside. The desktop was never switched to, so the
person kept their screen the whole time: their foreground window was unchanged after every probe,
and no window from that desktop ever appeared on theirs.

**Works on a desktop nobody is looking at**

- **Launching anything there.** An Electron app and `explorer.exe` both started and drew normally.
  Their windows enumerate on that desktop and are absent from `Default`.
- **Driving a Chromium app over CDP.** The debugging port is a TCP socket and does not care about
  desktops. `Runtime.evaluate`, `Input.insertText` and `Input.dispatchKeyEvent` all worked, and the
  page reported `document.hasFocus() === true`.
- **A genuine paste with no real input at all.** `Input.dispatchKeyEvent` with `commands: ['paste']`
  produced a `paste` event with `isTrusted: true` carrying the real clipboard contents. The brief
  listed this as untried; it removes one of the two cases that were thought to need the person's
  screen.
- **Screenshots two ways.** `Page.captureScreenshot` returns the web contents.
  `PrintWindow` with `PW_RENDERFULLCONTENT`, called from a process attached to that desktop, returns
  any window including its native frame. Explorer's window came back fully rendered.
- **Keyboard input through posted messages.** `PostMessage` of `WM_KEYDOWN`/`WM_CHAR`/`WM_KEYUP` to
  the Chromium child window arrived as `isTrusted: true` key events, with no foreground window
  anywhere.

**Does not work there**

- **No foreground window and no pointer.** `GetForegroundWindow` returns 0, `SetForegroundWindow`
  returns false, and `GetCursorPos`/`SetCursorPos` both fail. A desktop that has never been switched
  to has no input state of its own.
- **Therefore no `SendInput`/`keybd_event`.** Real key presses sent from a process on that desktop
  reached nothing; the target app's event log was unchanged.
- **No desktop-wide capture.** `BitBlt` from the desktop DC returns false and the bitmap is blank.
  Per-window `PrintWindow` is the only picture available.
- **Consequently no mouse-driven drag and drop.** OLE drag needs a real cursor and mouse capture and
  neither exists there, so dropping files into Explorer stays unverifiable in this shape.
- **The clipboard is shared**, as expected: the paste above picked up what the person had copied.

`SwitchDesktop` would give that desktop real input, and is how Sysinternals Desktops works, but it
takes the screen away from the person, which is the thing this feature exists to avoid. It was not
tried for that reason.

## What this does to the candidate shapes

B is no longer merely "the direct analogue of the agent browser"; it is the shape the measurements
support. C survives in a reduced form: the desktop is worth having as **a place to put windows so
they never appear on the person's screen**, not as a place where real input happens. The two collapse
into one design: an isolated desktop holding the agent's app instance, driven by CDP and posted
messages, observed through `Page.captureScreenshot` and `PrintWindow`.

The one case left uncovered is cross-app drag and drop. It needs the person's screen or a second
logon session, and is out of scope for the shape above.

## Decisions taken (2026-09-08)

1. **Scope: a product feature.** Any agent working in any project through astera, not only agents
   verifying astera itself.
2. **The clipboard is not isolated.** "The agent may overwrite the clipboard, but must not take the
   screen or the pointer" is the accepted line. A second logon session or a VM is out.
3. **Windows first.** Other platforms get whatever needs no real input. The desktop object is
   Windows-only, as `clipboardFiles.ts` already is.
4. **The first round targets an Electron app plus the OS around it.** That means the project's own
   app launched from a Run configuration, driven precisely, with the OS-integration cases that
   survive the measurements above.
5. **No CLI surface, and the Host owns it (2026-09-26).** The public `astera` CLI gets no command or
   flag for isolation. If it is built, it lives in the Host, so a Run started from the CLI with the app
   closed gets the same isolation as one started from the app: its workers still run in the user's
   logon session and would take the screen the same way. Where there is no interactive desktop (CI,
   SSH, a server), it switches itself off, since there is no screen to protect.
6. **The Host owns it whether the app is open or not (2026-09-26).** Whoever started the worker (the
   app while it is open, the Host once it has quit), the worker asks the Host for the hidden desktop and
   the app in it, so quitting the app mid-verification loses nothing. The open app only shows what the
   Host reports: captures or a marker that an agent is driving an app out of sight. The agent browser
   stays as it is, in the app, and still does not work with the app closed.

## Decided since (2026-09-27)

- **Who drives.** Decided (W3): a scripted API in the agent browser's style, `astera app js`.
- **Visibility.** Decided (W4): a mirror tab per session, with the latest capture in a violet frame,
  the running helper, a Stop and a Close.
- **Lifecycle.** Decided (W5): one desktop per session, created at the first `launch()`, cleaned up
  when the session ends, on `close()`, or after 10 minutes without a script.

## Suggested next step

Design the surface with the person, starting from the two open questions above. The mechanism no
longer needs proving; what needs deciding is what the agent is handed and how the person sees what
it is doing.

## Pointers

- The verification session that produced the measurements: develop `5ac2116`, the explorer clipboard
  work in both directions. `src/main/clipboardFiles.ts` carries the PowerShell route and the reason
  Electron cannot do it alone.
- An agent picking this up in Astera's own working setup also has local notes on the method
  (`electron-file-clipboard-and-drag`, `astera-dev-run-cdp`, `orca-peer-reference`); those are agent
  memory, not part of this repository.
- The spike was throwaway and is not in the repository. What it established is written above; the
  calls it used were `CreateDesktop`, `CreateProcess` with `STARTUPINFO.lpDesktop`,
  `EnumDesktopWindows`, `PrintWindow(PW_RENDERFULLCONTENT)`, `PostMessage`, and CDP over the app's
  debugging port. Two traps cost the most time: PowerShell turns `$null` into an empty string for a
  `[string]` P/Invoke argument (use `[NullString]::Value`, or `CreateProcess` fails with
  ERROR_PATH_NOT_FOUND), and a process on an invisible desktop has no console, so an `Add-Type` that
  fails to compile is silent and every later call returns `$null`.
