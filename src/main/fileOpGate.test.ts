import { describe, it, expect } from 'vitest'
import { t } from '../core/i18n'
import { processProbeBudget, rootOf } from '../core/sessions/pathProbe'
import { gateFolders, unreachableInLang, withUnreachableInLang } from './fileOpGate'

// Stage 4 T1 review (minor 3): the files.* handlers' translation of ROOT_UNREACHABLE (ipc.ts withFileOp,
// gateFolders, localHistory.restore), reached here by injection.
describe('the file handlers say "not reachable" in the person language', () => {
  it('ROOT_UNREACHABLE becomes files.error.unreachable; anything else passes as it is', () => {
    const translated = unreachableInLang(new Error('ROOT_UNREACHABLE: folder not reachable: Z:/p'), 'en')
    expect(String(translated)).toContain(t('en', 'files.error.unreachable'))
    const other = new Error('EACCES')
    expect(unreachableInLang(other, 'en')).toBe(other)
    expect(unreachableInLang(new Error('WORKTREE_ROOT_UNREACHABLE: x'), 'en')).not.toHaveProperty('message', t('en', 'files.error.unreachable'))
  })

  it('withUnreachableInLang translates what the work throws, and hands back what it answers', async () => {
    await expect(withUnreachableInLang('ko', async () => 7)).resolves.toBe(7)
    await expect(
      withUnreachableInLang('ko', async () => {
        throw new Error('ROOT_UNREACHABLE: folder not reachable: Z:/p')
      })
    ).rejects.toThrow(t('ko', 'files.error.unreachable'))
  })

  it('gateFolders asks every folder, and one that does not answer stops it in the person language', async () => {
    const asked: string[] = []
    await expect(
      gateFolders('en', ['C:/a', 'Z:/b', 'C:/c'], async (p) => {
        asked.push(p)
        return p.startsWith('Z') ? 'timeout' : 'present'
      })
    ).rejects.toThrow(t('en', 'files.error.unreachable'))
    expect(asked).toEqual(['C:/a', 'Z:/b'])
  })

  it('with three dead drives stuck, a live local folder still goes ahead (the default gate is past the cap)', async () => {
    const budget = processProbeBudget()
    try {
      for (const r of ['Q:/', 'R:/', 'S:/'].map(rootOf)) {
        const tk = await budget.enter(r)
        if (typeof tk === 'string') throw new Error(tk)
        tk.timedOut()
      }
      await expect(gateFolders('en', [process.cwd()])).resolves.toBeUndefined()
    } finally {
      budget.reset()
    }
  })
})
