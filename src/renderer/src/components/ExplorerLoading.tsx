import { useI18n } from '../i18n/I18nProvider'

/** How long the root's first read may take before the tree says it is still reading. Below this a
 *  folder answers fast enough that a message would only flash for a frame. */
export const ROOT_SLOW_MS = 300

/** The inline indicator on a folder row while its children are being read (useFileTree's `loading`).
 *  The shared .loading-spinner in its small size, so it sits inside a tree row's line height. */
export function RowLoading({ pending }: { pending: boolean }): React.JSX.Element | null {
  const { t } = useI18n()
  if (!pending) return null
  return <span className="loading-spinner small fx-row-loading" role="status" aria-label={t('explorer.dir.loading')} />
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
