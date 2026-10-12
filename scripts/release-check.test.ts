import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { FILES } from './release-files'

const REPO = resolve(import.meta.dir, '..')
const CHECK = join(import.meta.dir, 'release-check.ts')
const run = (args: string[]) => {
  const r = Bun.spawnSync(['bun', CHECK, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const coreVersion = JSON.parse(readFileSync(join(REPO, 'packages/brust/package.json'), 'utf8')).version as string
function copyRoot(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'release-check-'))
  for (const f of FILES) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true })
    cpSync(join(REPO, f), join(tmp, f))
  }
  return tmp
}

describe('release-check', () => {
  test('all eleven at the expected version → exit 0', () => {
    const tmp = copyRoot()
    const r = run([coreVersion, '--root', tmp])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`✓ 11/11 packages at ${coreVersion}`)
  })
  test('one off-version file → exit 1 naming it', () => {
    const tmp = copyRoot()
    const f = join(tmp, 'npm/linux-x64-musl/package.json')
    writeFileSync(f, readFileSync(f, 'utf8').replace(/("version"\s*:\s*")[^"]*(")/, '$10.0.1-x$2'))
    const r = run([coreVersion, '--root', tmp])
    expect(r.code).toBe(1)
    expect(r.err).toContain(`npm/linux-x64-musl/package.json: 0.0.1-x (expected ${coreVersion})`)
  })
  test('core-cf off-version → exit 1 naming it', () => {
    const tmp = copyRoot()
    const f = join(tmp, 'npm/core-cf/package.json')
    writeFileSync(f, readFileSync(f, 'utf8').replace(/("version"\s*:\s*")[^"]*(")/, '$10.0.1-x$2'))
    const r = run([coreVersion, '--root', tmp])
    expect(r.code).toBe(1)
    expect(r.err).toContain(`npm/core-cf/package.json: 0.0.1-x (expected ${coreVersion})`)
  })
  test('FILES has the six natives, core-cf and the three packages', () => {
    expect(FILES.length).toBe(11)
    expect(FILES).toContain('npm/core-cf/package.json')
  })
  test('wrong version against the real repo → exit 1 listing all eleven', () => {
    const r = run(['9.9.9-nope'])
    expect(r.code).toBe(1)
    for (const f of FILES) expect(r.err).toContain(f)
  })
})
