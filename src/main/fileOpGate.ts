// The files.* handlers' side of gateRoot (core/sessions/pathProbe.ts, stage 4 T1): a folder asked once
// through the probe budget before a handler touches it with unbudgeted calls, and ROOT_UNREACHABLE —
// thrown by that gate, by fsTree and by the Local History store — said in the person's language.
// Apart from ipc.ts so it can be tested by injection.
import { t, type Lang } from '../core/i18n'
import { gateRoot, isRootUnreachable, type Probe } from '../core/sessions/pathProbe'

/** ROOT_UNREACHABLE as files.error.unreachable in `lang`; anything else as it is. */
export function unreachableInLang(err: unknown, lang: Lang): unknown {
  return isRootUnreachable(err) ? new Error(t(lang, 'files.error.unreachable')) : err
}

/** Runs `work`, translating a ROOT_UNREACHABLE it throws (unreachableInLang). */
export async function withUnreachableInLang<T>(lang: Lang, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    throw unreachableInLang(err, lang)
  }
}

/** Asks each folder in turn through gateRoot (by default past the stuck-call cap: a person is waiting),
 *  and stops at the first that does not answer, with files.error.unreachable in `lang`. */
export function gateFolders(lang: Lang, folders: string[], gate?: Probe): Promise<void> {
  return withUnreachableInLang(lang, async () => {
    for (const f of folders) await gateRoot(f, gate)
  })
}
