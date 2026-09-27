// The Host's rolling lines go to the same rolling.log the app writes (S6 R10), so one file tells what
// happened to a session whichever process rolled it. Through the shared log writer (stage 3, task 3):
// buffered and appended asynchronously, one writer for both prefixes so their lines keep one order.
import path from 'node:path'
import { lineLog } from '../core/log/logWriter'

/** Appends one line to <profile>/rolling.log with the prefix; never throws (R10). */
export function hostRollingLog(profileDir: string, prefix: '[host]' | '[host][codex]'): (m: string) => void {
  const log = lineLog(path.join(profileDir, 'rolling.log'))
  return (m) => log(`${prefix} ${m}`)
}
