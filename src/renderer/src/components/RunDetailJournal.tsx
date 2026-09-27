// The run-detail window's two notes about its Job Journal lines (stage 3 T1). The journal is read on
// Electron's main thread, so main reads only the newest page of those lines, and a journal the Host holds
// locked answers at once with the lines last read instead of making the window wait.
import { useI18n } from '../i18n/I18nProvider'
import type { RunDetailJournal } from '../../../core/types'

/** "Show older journal entries", only while main says older lines are left. Each press asks for one more
 *  page (App.tsx keeps the count); the window asks again at every snapshot change with the same count. */
export function JournalOlder({
  journal,
  onShowOlder
}: {
  journal: RunDetailJournal | undefined
  onShowOlder: () => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  if (!journal?.older) return null
  return (
    <button className="detail-journal-older" onClick={onShowOlder}>
      {t('jobs.detail.journalOlder')}
    </button>
  )
}

/** One quiet line while the journal was busy at the last read: the lines shown are the last ones read. */
export function JournalBusy({ journal }: { journal: RunDetailJournal | undefined }): React.JSX.Element | null {
  const { t } = useI18n()
  if (!journal?.busy) return null
  return <p className="modal-hint">{t('jobs.detail.journalBusy')}</p>
}
