// `--shadcn[=a,b]` (F181): after the scaffold, install the project and run its own `brust shadcn init`.
// Every child is an argv array (no shell). The project's own `node_modules/.bin/brust` is run by path, never `bunx brust`,
// which could fetch an unrelated package named `brust` from the registry when the local one is missing.
import { join } from 'node:path'

/** Runs `argv` in `cwd` with the terminal attached; resolves to the exit code. */
export type Runner = (argv: string[], cwd: string) => Promise<number>

export const spawnRunner: Runner = async (argv, cwd) => {
  try {
    const p = Bun.spawn(argv, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    return await p.exited
  } catch {
    return 127
  }
}

/** Returns 0 when done, else the failing step's exit code (the project is left in place; `lines` says what to run). */
export async function runShadcn(o: { targetDir: string; components: string[]; workspace: boolean; run: Runner; out: (line: string) => void }): Promise<number> {
  const { targetDir, components, out } = o
  const by = `cd ${targetDir} && bun install && node_modules/.bin/brust shadcn init${components.map((c) => ` ${c}`).join('')}`
  if (o.workspace) {
    out('--shadcn: this app is a workspace member of a brust checkout; run `bun install` at the repo root, then in the app:')
    out(`  node_modules/.bin/brust shadcn init${components.map((c) => ` ${c}`).join('')}`)
    return 0
  }
  out('\n--shadcn: installing, then running `brust shadcn init` (needs @brust/core 2.0.0-alpha.11 or later)')
  const install = await o.run(['bun', 'install'], targetDir)
  if (install !== 0) {
    out(`create-app: bun install failed (exit ${install}); the project is created. Finish with: ${by}`)
    return install
  }
  const init = await o.run([join(targetDir, 'node_modules/.bin/brust'), 'shadcn', 'init', ...components], targetDir)
  if (init !== 0) {
    out(`create-app: brust shadcn init failed (exit ${init}); the project is created. Run again: cd ${targetDir} && node_modules/.bin/brust shadcn init${components.map((c) => ` ${c}`).join('')}`)
  }
  return init
}
