import { expect, test } from 'bun:test'
import { runShadcn } from '../src/shadcn.ts'

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
