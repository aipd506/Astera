import type { WorktreeCreateProgress, WorktreeCreateStage } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

const STAGE_KEY: Record<WorktreeCreateStage, MessageKey> = {
  fetch: 'session.new.stage.fetch',
  checkout: 'session.new.stage.checkout',
  'copy-includes': 'session.new.stage.copyIncludes'
}

/** Byte size in short units, one decimal past bytes (LocalHistoryDialog keeps its own copy; the two are
 *  small enough that sharing would cost more than it saves). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(1)}${units[i]}`
}

/** The busy overlay of the new-session dialog. Starting with a worktree used to show one spinner line
 *  for fetch, `worktree add` and the include copy together — for minutes on a big repository, with no
 *  sign of life and no way out. Now it names the stage, shows the copy as a bar with bytes and files,
 *  and offers Cancel for as long as the worktree is being made. Once it is made (`created`), what is
 *  left is starting the session, which cannot be cancelled, so the button goes. */
export function StartingOverlay({
  withWorktree,
  progress,
  created,
  cancelling,
  onCancel
}: {
  withWorktree: boolean
  progress: WorktreeCreateProgress | null
  created: boolean
  cancelling: boolean
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const making = withWorktree && !created
  const label = !making
    ? t('session.new.starting')
    : progress
      ? t(STAGE_KEY[progress.stage])
      : t('session.new.startingWorktree')
  const copy =
    making && progress?.stage === 'copy-includes' && progress.bytesTotal !== undefined ? progress : null
  const pct =
    copy && copy.bytesTotal
      ? Math.min(100, Math.round(((copy.bytesCopied ?? 0) / copy.bytesTotal) * 100))
      : copy && copy.filesTotal
        ? Math.min(100, Math.round(((copy.filesCopied ?? 0) / copy.filesTotal) * 100))
        : 0
  return (
    <div className="loading-overlay worktree-create-status" role="status">
      <span className="loading-spinner" aria-hidden="true" />
      <div className="worktree-create-body">
        <span>{label}</span>
        {copy && (
          <>
            <div className="worktree-progress-bar" aria-hidden="true">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span className="worktree-progress-count">
              {t('session.new.stage.copyCount', {
                copied: formatBytes(copy.bytesCopied ?? 0),
                total: formatBytes(copy.bytesTotal ?? 0),
                files: copy.filesCopied ?? 0,
                filesTotal: copy.filesTotal ?? 0
              })}
            </span>
          </>
        )}
      </div>
      {making && (
        <button type="button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? t('session.new.cancelling') : t('common.cancel')}
        </button>
      )}
    </div>
  )
}
