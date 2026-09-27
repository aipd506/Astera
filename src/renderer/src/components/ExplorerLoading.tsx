import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../../../core/i18n'
import type { FileOpStage } from '../../../core/types'
import type { FileOpStatus } from '../../../core/files/fileOpBusy'

/** How long the root's first read may take before the tree says it is still reading. Below this a
 *  folder answers fast enough that a message would only flash for a frame. */
export const ROOT_SLOW_MS = 300

/** The inline indicator on a folder row while its children are being read (useFileTree's `loading`).
 *  The shared .loading-spinner in its small size, so it sits inside a tree row's line height. */
export function RowLoading({
  pending,
  label = 'explorer.dir.loading'
}: {
  pending: boolean
  /** What the spinner announces — a delete or copy on the row passes files.op.busy. */
  label?: MessageKey
}): React.JSX.Element | null {
  const { t } = useI18n()
  if (!pending) return null
  return <span className="loading-spinner small fx-row-loading" role="status" aria-label={t(label)} />
}

const STAGE_TEXT: Record<FileOpStage, MessageKey> = {
  snapshot: 'files.op.snapshotting',
  delete: 'files.op.deleting',
  copy: 'files.op.copying'
}

/** The status line of a delete or paste that has run past OP_STATUS_DELAY_MS (useFileOps' opStatus is
 *  null until then): what it is doing and how many entries so far, with the spinner. Before main's
 *  first report it names the operation itself. */
export function FileOpStatusLine({ status }: { status: FileOpStatus | null }): React.JSX.Element | null {
  const { t } = useI18n()
  if (!status) return null
  const key: MessageKey = status.stage
    ? STAGE_TEXT[status.stage]
    : status.kind === 'delete'
      ? 'files.op.deleting'
      : 'files.op.copying'
  return (
    <div className="fx-note fx-reading fx-op-status" role="status">
      <span className="loading-spinner small" aria-hidden="true" />
      {t(key, { count: status.count })}
    </div>
  )
}

/** What the tree shows while the root's first read is still out. Nothing until it has taken longer
 *  than ROOT_SLOW_MS (the caller decides that — `slow`), then "Reading folder…" with the spinner, so a
 *  big folder or a shared drive never looks like an empty or frozen explorer. */
export function RootReading({ slow }: { slow: boolean }): React.JSX.Element | null {
  const { t } = useI18n()
  if (!slow) return null
  return (
    <div className="fx-note fx-reading" role="status">
      <span className="loading-spinner small" aria-hidden="true" />
      {t('explorer.dir.reading')}
    </div>
  )
}
