// The order the app starts in, pulled out of index.ts so it can be tested without Electron.
//
// On macOS and Linux the login-shell PATH probe (loginPath.ts: `$SHELL -ilc`, up to 5 s) used to run
// before anything else, so a slow rc file meant several seconds with no window at all — the app
// looked as if it had not launched. Now the window opens first and shows that start-up is under way,
// and only what needs PATH waits for the probe: createCore (it bakes the node path into the
// statusLine hook files and detects accounts), and with it every session spawn, since nothing can
// spawn before core exists. The wait is bounded (LOGIN_PATH_GATE_MS) even if the shell will not die.
//
// Windows is untouched: there is no probe there (readLoginPath returns at once), and the order stays
// probe, core, window.

/** How long start-up waits for the login-shell probe at most. The probe's own execFile timeout is
 *  5 s, but that kills the shell and then waits for its pipes, which a child of the rc file can hold
 *  open; this deadline does not depend on the shell dying. */
export const LOGIN_PATH_GATE_MS = 6_000

/** Resolves once the probe settles or the deadline passes, whichever is first. Never rejects: a probe
 *  that fails keeps the inherited PATH, which is what applyLoginPath does itself. */
export function gateOnLoginPath(
  probe: Promise<void>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<'applied' | 'timedOut'> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<'timedOut'>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve('timedOut')
    }, timeoutMs)
  })
  const settled = probe.then(
    () => 'applied' as const,
    () => 'applied' as const
  )
  return Promise.race([settled, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export async function startUp<W, C>(deps: {
  platform: NodeJS.Platform
  /** applyLoginPath — patches process.env.PATH; a no-op on win32. */
  probeLoginPath: () => Promise<void>
  /** Creates the main window. On macOS/Linux it is called before the probe resolves, so it must not
   *  need core; the caller loads the app into it once core and the IPC handlers exist. */
  openWindow: () => W
  createCore: () => Promise<C>
  log: (m: string) => void
  gateMs?: number
}): Promise<{ win: W; core: C }> {
  if (deps.platform === 'win32') {
    await deps.probeLoginPath().catch(() => {})
    const core = await deps.createCore()
    return { win: deps.openWindow(), core }
  }
  // Started before the window, so the shell is already running while the window is drawn.
  let probe: Promise<void>
  try {
    probe = deps.probeLoginPath()
  } catch (err) {
    probe = Promise.reject(err)
  }
  const win = deps.openWindow()
  await gateOnLoginPath(probe, deps.gateMs ?? LOGIN_PATH_GATE_MS, () =>
    deps.log(
      `loginPath: the login shell did not answer within ${deps.gateMs ?? LOGIN_PATH_GATE_MS} ms — starting with the inherited PATH`
    )
  )
  const core = await deps.createCore()
  return { win, core }
}

/** The page the window shows while start-up waits on the login shell: the app's name, a spinner and
 *  one line saying what it is waiting for. Inline (a data URL) because the app's own page cannot load
 *  yet — its IPC handlers are registered only once core exists. */
export function startingPageUrl(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Astera</title><style>
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--ring:#d0d7de;--accent:#3b82f6}
@media (prefers-color-scheme: dark){:root{--bg:#1e1e1e;--fg:#e6e6e6;--muted:#9da3ab;--ring:#3a3a3a}}
html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font:13px system-ui,-apple-system,sans-serif}
body{display:flex;align-items:center;justify-content:center;-webkit-app-region:drag}
.box{display:flex;flex-direction:column;align-items:center;gap:12px}
.name{font-size:16px;font-weight:600}
.row{display:flex;align-items:center;gap:8px;color:var(--muted)}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--ring);border-top-color:var(--accent);animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="box"><div class="name">Astera</div><div class="row"><span class="spinner"></span><span>${escaped}</span></div></div></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** The part of a BrowserWindow loadInto uses. */
export interface LoadableWindow {
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  loadFile(file: string): Promise<void>
}

/**
 * Loads a page into the window without letting the load's failure escape.
 *
 * Both loads here can fail in ordinary ways: the start-up page is replaced by the app's page mid-load
 * when the probe answers quickly (loadURL rejects with ERR_ABORTED), and on Linux closing the window
 * during the probe quits the app and destroys the window before the app's page is loaded into it —
 * where loadURL would throw inside whenReady. A destroyed window is left alone; a rejected load is
 * logged, never unhandled.
 */
export function loadInto(
  win: LoadableWindow,
  target: { url: string } | { file: string },
  log: (m: string) => void
): void {
  if (win.isDestroyed()) return
  try {
    const loading = 'url' in target ? win.loadURL(target.url) : win.loadFile(target.file)
    loading.catch((err: unknown) => log(`window load did not finish: ${(err as Error)?.message ?? String(err)}`))
  } catch (err) {
    log(`window load failed: ${(err as Error)?.message ?? String(err)}`)
  }
}
