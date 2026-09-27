import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../../../core/i18n'
import type { HostRuntimeInstallState } from '../../../core/types'

/** Every string this notice can show — kept in one list so the test can hold all four catalogs to it. */
export const HOST_RUNTIME_NOTICE_KEYS: readonly MessageKey[] = [
  'status.hostPreparing',
  'status.hostPreparingSlow',
  'status.hostPrepareFailed',
  'status.hostPrepareFailedTitle'
]

/**
 * The status bar's word on the Host's own runtime being put in place (stage 3 task 2).
 *
 * A first install after an update copies an 87 MB `node.exe` that an antivirus then scans. That used
 * to happen with the window frozen and nothing on screen; now the copy runs off the main thread and
 * this says what is going on. Nothing while nothing is being written — main only leaves `idle` once it
 * actually writes — then "Preparing the Astera Host…" with the shared spinner, and once it has run past
 * about a second, that it is still working and for how long, so a long scan never reads as a hang.
 *
 * A failure is said in the same amber the other Host notices use, with the reason in the title: the
 * Host then runs from the app executable as it always could, and the next start tries again.
 */
export function HostRuntimeNotice({
  state,
  nowMs
}: {
  state: HostRuntimeInstallState | null
  /** The clock the elapsed seconds are read against — App ticks it while an install is slow. */
  nowMs: number
}): React.JSX.Element | null {
  const { t } = useI18n()
  if (!state || state.phase === 'idle') return null
  if (state.phase === 'failed') {
    return (
      <span className="status-host-runtime failed" title={t('status.hostPrepareFailedTitle', { detail: state.detail })}>
        {t('status.hostPrepareFailed')}
      </span>
    )
  }
  const seconds = Math.max(0, Math.floor((nowMs - state.startedAt) / 1000))
  return (
    <span className="status-host-runtime" role="status">
      <span className="loading-spinner small" aria-hidden="true" />
      {state.slow ? t('status.hostPreparingSlow', { seconds }) : t('status.hostPreparing')}
    </span>
  )
}
