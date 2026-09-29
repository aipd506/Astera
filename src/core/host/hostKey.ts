// The Host proves who it is before a client hands it anything (security review 2026-09-28, the Windows
// pipe squat). The address is a hash of a guessable profile path, and on win32 a named pipe has no
// directory whose owner could be checked the way socketDir.ts checks one on posix: another account
// on the machine can create the pipe first, and the app and `astera` would connect to it and give it
// every terminal's environment and keystrokes. So the Host keeps a random key in the profile folder,
// which only this account can read, and answers each client's nonce with an HMAC of it. A client
// that gets no answer, or a wrong one, is not talking to this account's Host and sends nothing more.
//
// The key never crosses the pipe, and a squatter that relays a real Host's answer learns nothing it
// can use: every nonce is new. On posix the socket directory check stays (socketDir.ts); this is the
// same question asked in a way that also holds on Windows.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const KEY_RE = /^[0-9a-f]{64}$/

/** `<profile>/host/host.key` — beside the Host's log and pid file, in the folder only this account can read. */
export function hostKeyPath(profileDir: string): string {
  return path.join(profileDir, 'host', 'host.key')
}

/** The key, or null when there is none or the file holds something else. For clients: a client never
 *  makes a key, since a key it made could not be the one the Host answers with. */
export async function readHostKey(profileDir: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(hostKeyPath(profileDir), 'utf8')).trim()
    return KEY_RE.test(text) ? text : null
  } catch {
    return null
  }
}

/** The key, made if there is none. For the Host, before it binds. **Mode 0600**: on posix a profile
 *  folder is often readable by other accounts, and this file is the whole proof. Two Hosts starting
 *  at once agree on one key: the file is created exclusively, and whoever loses reads the winner's. A
 *  file holding no key is replaced. */
export async function ensureHostKey(profileDir: string): Promise<string> {
  const file = hostKeyPath(profileDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readHostKey(profileDir)
    if (existing) return existing
    const key = randomBytes(32).toString('hex')
    try {
      await fs.writeFile(file, key, { flag: 'wx', mode: 0o600 })
      return key
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Somebody wrote first: theirs is read on the next turn. A file that holds no key is taken away
      // so the next turn can write one.
      if ((await readHostKey(profileDir)) === null) {
        // Only a file that is still not a key once a racing writer has had a moment to finish
        await new Promise((r) => setTimeout(r, 20))
        if ((await readHostKey(profileDir)) === null) await fs.rm(file, { force: true })
      }
    }
  }
  const settled = await readHostKey(profileDir)
  if (settled) return settled
  throw new Error(`could not make the Host key at ${file}`)
}

/** A fresh nonce for one hello. */
export function newHostNonce(): string {
  return randomBytes(16).toString('hex')
}

/** What the Host answers to `nonce`. The prefix keeps this HMAC from ever meaning anything else. */
export function hostProof(key: string, nonce: string): string {
  return createHmac('sha256', key).update(`astera-host-proof\n${nonce}`).digest('hex')
}

/** Whether `proof` is the answer to `nonce` under `key`. Compared in constant time; anything that is
 *  not a proof of the right shape is simply not one. */
export function proofMatches(key: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  return timingSafeEqual(Buffer.from(hostProof(key, nonce), 'hex'), Buffer.from(proof, 'hex'))
}
