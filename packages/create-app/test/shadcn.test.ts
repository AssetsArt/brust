import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShadcn, shq } from '../src/shadcn.ts'

function go(failOn?: string, workspace = false) {
  const calls: string[][] = []
  const lines: string[] = []
  const p = runShadcn({ targetDir: '/p/app', components: ['button', 'card'], workspace, run: async (a) => { calls.push(a); return failOn && a.includes(failOn) ? 3 : 0 }, out: (l) => lines.push(l) })
  return p.then((code) => ({ code, calls, lines }))
}

test('--shadcn installs, then runs the project-local brust bin by path (never bunx), as argv arrays', async () => {
  const r = await go()
  expect(r.code).toBe(0)
  expect(r.calls).toEqual([['bun', 'install'], ['/p/app/node_modules/.bin/brust', 'shadcn', 'init', 'button', 'card']])
})
test('a failed install stops before init and says how to finish; a failed init returns its code', async () => {
  const a = await go('install')
  expect([a.code, a.calls.length]).toEqual([3, 1])
  expect(a.lines.join('\n')).toContain('bun install failed')
  const b = await go('shadcn')
  expect(b.code).toBe(3)
  expect(b.lines.join('\n')).toContain('brust shadcn init failed')
})
test('a workspace member runs nothing and prints the two commands', async () => {
  const r = await go(undefined, true)
  expect([r.code, r.calls]).toEqual([0, []])
  expect(r.lines.join('\n')).toContain('brust shadcn init button card')
})

test('shq: a shell reads back the exact string for hostile directories and components; plain words stay bare', () => {
  expect([shq('button'), shq('/p/app')]).toEqual(['button', '/p/app'])
  for (const x of ["/tmp/x$(echo PWNED)`id`'q", 'https://u.dev/a.json;rm', 'a b', '$HOME', '']) {
    const r = Bun.spawnSync(['sh', '-c', `printf '%s' ${shq(x)}`], { stdout: 'pipe' })
    expect(r.stdout.toString()).toBe(x)
  }
})

const HOSTILE = ['$(echo X)', '`id`', '$HOME', 'a;b', 'a&b', 'a|b', "it's", 'a b', 'two\nlines', 'https://u.dev/a.json;rm -rf x']

/** Executes each printed command line in a real sh with stub `bun` and `brust`; the stub brust records its argv. */
async function replay(which: 'finish' | 'again' | 'workspace'): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'ca-rt-'))
  const dir = join(base, 'p $(touch PWNED) `touch PWNED2` \'q\'')
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true })
  const stub = join(base, 'stub')
  mkdirSync(stub)
  writeFileSync(join(stub, 'bun'), '#!/bin/sh\nexit 0\n')
  const rec = join(base, 'argv')
  writeFileSync(join(dir, 'node_modules/.bin/brust'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > ${JSON.stringify(rec)}\n`)
  chmodSync(join(stub, 'bun'), 0o755)
  chmodSync(join(dir, 'node_modules/.bin/brust'), 0o755)
  const lines: string[] = []
  const fail = which === 'finish' ? 'install' : which === 'again' ? 'shadcn' : ''
  await runShadcn({ targetDir: dir, components: HOSTILE, workspace: which === 'workspace', run: async (a) => (fail && (a.includes(fail) || a[0]?.endsWith(fail)) ? 1 : 0), out: (l) => lines.push(l) })
  const printed = lines.find((l) => /node_modules\/\.bin\/brust shadcn init/.test(l))!
  const cmd = printed.slice(printed.search(/cd '|cd \/|node_modules\/\.bin\/brust/)).trim()
  const r = Bun.spawnSync(['sh', '-c', which === 'workspace' ? `cd ${shq(dir)} && ${cmd}` : cmd], { cwd: base, env: { ...process.env, PATH: `${stub}:${process.env.PATH}` }, stderr: 'pipe' })
  expect(r.stderr.toString()).toBe('')
  expect(readFileSync(rec, 'utf8').split('\0').slice(0, -1)).toEqual(['shadcn', 'init', ...HOSTILE])
  for (const d of [base, dir]) for (const f of ['PWNED', 'PWNED2']) expect(existsSync(join(d, f))).toBe(false)
}
test('round trip: the "Finish with" line, run by a real sh, passes the exact hostile args and expands nothing', () => replay('finish'))
test('round trip: the "Run again" line, run by a real sh, passes the exact hostile args and expands nothing', () => replay('again'))
test('round trip: the workspace line, run by a real sh, passes the exact hostile args', () => replay('workspace'))
