// An agent app workspace's mirror (agent workspace design, Mirror tab; W4): the latest picture of the
// agent's app on a desktop the person never sees, in the agent's violet frame, with the helper that is
// running, a Stop and a Close. The person watches; they do not drive.
import { useI18n } from '../i18n/I18nProvider'
import { mirrorStatus, type MirrorEntry } from '../lib/workspaceMirror'

export function AppMirrorPane(props: {
  sessionTitle: string
  mirror: MirrorEntry | null
  onStop(): void
  onClose(): void
}): React.JSX.Element {
  const { t } = useI18n()
  const m = props.mirror
  const open = m?.open === true
  const s = mirrorStatus(m)
  const status = 'params' in s ? t(s.key, s.params) : t(s.key)
  return (
    <div className="app-mirror">
      <div className="app-mirror-bar">
        <span className="app-mirror-title">{t('workspace.pane.title', { session: props.sessionTitle })}</span>
        <span className="app-mirror-status">{status}</span>
        <button type="button" className="app-mirror-btn" disabled={m?.running !== true} onClick={props.onStop}>
          {t('workspace.pane.stop')}
        </button>
        <button type="button" className="app-mirror-btn" disabled={!open} onClick={props.onClose}>
          {t('workspace.pane.close')}
        </button>
      </div>
      <div className={`app-mirror-stage${open ? '' : ' closed'}${m?.running ? ' running' : ''}`}>
        {m?.frame ? (
          <img
            className="app-mirror-frame"
            src={`data:image/jpeg;base64,${m.frame.jpeg}`}
            width={m.frame.width}
            height={m.frame.height}
            alt={t('workspace.pane.alt')}
            draggable={false}
          />
        ) : (
          <div className="app-mirror-empty">{open ? t('workspace.pane.waiting') : t('workspace.pane.closed')}</div>
        )}
      </div>
    </div>
  )
}
