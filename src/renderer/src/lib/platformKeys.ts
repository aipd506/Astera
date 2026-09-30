// The key names a label shows, by platform. The handlers already accept Cmd on macOS (they test
// `ctrlKey || metaKey`); these are for the text that tells a person which key to press, so that a
// macOS menu does not say Ctrl. Functions rather than constants: they read `window.api` when called,
// so a module that imports this can still be loaded where there is no preload (a node test).

export function isMac(): boolean {
  return window.api.platform === 'darwin'
}

/** The modifier of the clipboard and undo shortcuts: Cmd on macOS, Ctrl elsewhere. */
export function modKey(): string {
  return isMac() ? 'Cmd' : 'Ctrl'
}

/** How the explorer's delete shortcut is written. A Mac keyboard's delete key is Backspace, so the
 *  explorer takes Cmd+Backspace there (the Finder's shortcut); the forward Delete key works on both. */
export function deleteKey(): string {
  return isMac() ? 'Cmd+Backspace' : 'Del'
}
