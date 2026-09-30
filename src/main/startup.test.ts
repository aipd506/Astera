import { describe, it, expect, vi, afterEach } from 'vitest'
import { startUp, gateOnLoginPath, startingPageUrl, loadInto, storedTheme, LOGIN_PATH_GATE_MS } from './startup'
import { DEFAULT_THEME_ID, themeById } from '../core/theme/themes'

afterEach(() => {
  vi.useRealTimers()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('startUp — macOS/Linux: the window before the login-shell PATH probe', () => {
  // The probe runs `$SHELL -ilc` and can take its full 5 s. The app used to show nothing at all
  // until it answered; now the window is up at once and only what needs PATH waits for it.
  it('opens the window before the probe resolves, and creates core (every spawn) only after it', async () => {
    const probe = deferred()
    const order: string[] = []
    const started = startUp({
      platform: 'darwin',
      probeLoginPath: () => {
        order.push('probe')
        return probe.promise.then(() => void order.push('probe done'))
      },
      openWindow: () => {
        order.push('window')
        return 'win'
      },
      createCore: async () => {
        order.push('core')
        return 'core'
      },
      log: () => {}
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual(['probe', 'window'])
    probe.resolve()
    expect(await started).toEqual({ win: 'win', core: 'core' })
    expect(order).toEqual(['probe', 'window', 'probe done', 'core'])
  })

  it('a probe that never answers holds core only until the gate deadline, and says so', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const createCore = vi.fn(async () => 'core')
    const started = startUp({
      platform: 'linux',
      probeLoginPath: () => new Promise<void>(() => {}),
      openWindow: () => 'win',
      createCore,
      log
    })
    await vi.advanceTimersByTimeAsync(LOGIN_PATH_GATE_MS - 1)
    expect(createCore).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await started).toEqual({ win: 'win', core: 'core' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('loginPath'))
  })

  it('a probe that rejects still lets start-up through (no unhandled rejection)', async () => {
    const started = startUp({
      platform: 'darwin',
      probeLoginPath: () => Promise.reject(new Error('boom')),
      openWindow: () => 'win',
      createCore: async () => 'core',
      log: () => {}
    })
    await expect(started).resolves.toEqual({ win: 'win', core: 'core' })
  })
})

describe('startUp — Windows keeps its order', () => {
  it('probe, then core, then the window — exactly as before', async () => {
    const order: string[] = []
    await startUp({
      platform: 'win32',
      probeLoginPath: async () => void order.push('probe'),
      openWindow: () => {
        order.push('window')
        return 'win'
      },
      createCore: async () => {
        order.push('core')
        return 'core'
      },
      log: () => {}
    })
    expect(order).toEqual(['probe', 'core', 'window'])
  })
})

describe('gateOnLoginPath', () => {
  it('resolves when the probe does', async () => {
    await expect(gateOnLoginPath(Promise.resolve(), 1_000, () => {})).resolves.toBe('applied')
  })
  it('resolves at the deadline when the probe does not', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const gate = gateOnLoginPath(new Promise<void>(() => {}), 100, onTimeout)
    await vi.advanceTimersByTimeAsync(100)
    await expect(gate).resolves.toBe('timedOut')
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
})

// What the window shows while the probe runs: the app is up and says what it is waiting on.
describe('startingPageUrl', () => {
  it('is a data URL page carrying the text (escaped) and a spinner', () => {
    const url = startingPageUrl('Reading <your> shell…')
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    const html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain('Reading &lt;your&gt; shell…')
    expect(html).toContain('spinner')
  })

  // Measured 2026-09-29 on macOS in light mode: the page followed the OS and stood white for as long
  // as the login shell took (up to six seconds), then the app came up dark — every theme the app has
  // is dark. The page now wears the app's theme, whatever the OS says.
  it('wears the theme it is given, and never switches to a light page with the OS', () => {
    const orion = themeById('orion')
    const html = decodeURIComponent(startingPageUrl('x', orion).slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain(orion.colors.bg)
    expect(html).toContain(orion.colors.text)
    expect(html).not.toContain('prefers-color-scheme')
    expect(html).not.toContain('#ffffff')
    expect(html).toContain('color-scheme:dark')
  })

  it('wears the default theme when given none', () => {
    const html = decodeURIComponent(startingPageUrl('x').slice('data:text/html;charset=utf-8,'.length))
    expect(html).toContain(themeById(DEFAULT_THEME_ID).colors.bg)
  })
})

describe('storedTheme', () => {
  it('reads the theme app-settings.json names', async () => {
    expect((await storedTheme(async () => JSON.stringify({ theme: 'orion' }))).id).toBe('orion')
  })
  it('falls back to the default for a missing file, a damaged one or an unknown theme', async () => {
    for (const read of [
      async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
      async () => '{not json',
      async () => JSON.stringify({ theme: 'nebula' }),
      async () => JSON.stringify([])
    ])
      expect((await storedTheme(read)).id).toBe(DEFAULT_THEME_ID)
  })
})

// A window the start-up page or the app is loaded into can be replaced mid-load (loadURL rejects with
// ERR_ABORTED) or, on Linux, closed during the probe — which quits the app and destroys it.
describe('loadInto', () => {
  function fakeWin(opts: { destroyed?: boolean; reject?: boolean }) {
    const loadURL = vi.fn(() => (opts.reject ? Promise.reject(new Error('ERR_ABORTED')) : Promise.resolve()))
    const loadFile = vi.fn(() => Promise.resolve())
    return { isDestroyed: () => opts.destroyed === true, loadURL, loadFile }
  }

  it('a load that is aborted does not leave an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      loadInto(fakeWin({ reject: true }), { url: 'data:text/html,x' }, () => {})
      await new Promise((r) => setTimeout(r, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a destroyed window is left alone rather than thrown on', () => {
    const win = fakeWin({ destroyed: true })
    win.loadURL.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })
    expect(() => loadInto(win, { url: 'http://localhost' }, () => {})).not.toThrow()
    expect(win.loadURL).not.toHaveBeenCalled()
  })

  it('loads a URL or a file as asked', () => {
    const win = fakeWin({})
    loadInto(win, { url: 'http://localhost:5173' }, () => {})
    loadInto(win, { file: '/app/index.html' }, () => {})
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(win.loadFile).toHaveBeenCalledWith('/app/index.html')
  })
})
