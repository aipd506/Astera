import { toBatch, type FileChange, type FileChangeBatch } from '../../../core/files/changeBatch'

type On = (channel: 'files:changed' | 'files:changedBatch', cb: (payload: unknown) => void) => () => void

/** Subscribes to the file watcher in the batch shape. Main sends `files:changedBatch` (one message per
 *  batching window); the older one-event `files:changed` is still accepted and turned into a batch of
 *  one, so both shapes reach the same handler. `on` is injected (window.api.on in the app) so this can
 *  be tested without a preload. */
export function subscribeFileChanges(on: On, cb: (batch: FileChangeBatch) => void): () => void {
  const offBatch = on('files:changedBatch', (b) => cb(b as FileChangeBatch))
  const offOne = on('files:changed', (c) => cb(toBatch([c as FileChange])))
  return () => {
    offBatch()
    offOne()
  }
}

/** The app's subscription — window.api.on bound in. */
export function onFileChanges(cb: (batch: FileChangeBatch) => void): () => void {
  return subscribeFileChanges(window.api.on as unknown as On, cb)
}
