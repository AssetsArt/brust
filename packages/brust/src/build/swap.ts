// F485 P8: replacing `dist` by the finished temp dir. On Windows a rename of a directory fails (EPERM / EBUSY /
// EACCES) while anything holds a handle inside it (a running `brust start`, an indexer, an antivirus scan), so the
// rename is retried briefly and then fails with a message that says what to stop. On POSIX the first try succeeds.
import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { BuildError } from './errors'

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])
export const RENAME_TRIES = 5
export const RENAME_WAIT_MS = 100

export interface SwapOps {
  rename: (from: string, to: string) => void
  sleep: (ms: number) => void
}

const real: SwapOps = {
  rename: renameSync,
  sleep: (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
}

/** `renameSync` that retries a held-handle failure `RENAME_TRIES` times, `RENAME_WAIT_MS` apart. */
export function renameRetry(from: string, to: string, dist: string, ops: SwapOps = real): void {
  for (let i = 1; ; i++) {
    try {
      ops.rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === undefined || !BUSY.has(code)) throw e
      if (i >= RENAME_TRIES)
        throw new BuildError('dist-busy', `cannot replace ${dist} (${code}): stop a running \`brust start\` or anything holding files in it, then build again`)
      ops.sleep(RENAME_WAIT_MS)
    }
  }
}

/** Puts `tmp` in place of `dist`; the previous dist goes through `.<name>.brust-old` and is removed after. */
export function swapDist(tmp: string, dist: string, ops: SwapOps = real): void {
  if (existsSync(dist)) {
    const old = join(dirname(dist), `.${basename(dist)}.brust-old`)
    rmSync(old, { recursive: true, force: true })
    renameRetry(dist, old, dist, ops)
    renameRetry(tmp, dist, dist, ops)
    rmSync(old, { recursive: true, force: true })
  } else renameRetry(tmp, dist, dist, ops)
}
