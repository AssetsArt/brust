// F189: `Bun.resolveSync` answers the CJS `main` of a package that has both (recharts: `main` is a CJS build, `module`
// the ES build), so a package resolved from a directory the bundler does not walk (a package's own, for what its source
// imports) became a second, CJS copy beside the ESM one every other island imports. Re-implementing the bundler's
// choice drifts (conditions per target, the `browser` field, `development`, `module` before `import`), so this asks
// the bundler itself: a throwaway `Bun.build` of a virtual file placed in `from` that imports `spec`, with the same
// `target`; the first module the build loads from outside that file is the answer. Equal to the native pick by
// construction. It runs in a child process: a `Bun.build` started inside a plugin callback of another build deadlocks.
// Anything it cannot resolve falls back to `Bun.resolveSync`, which is today's answer.
import { join } from 'node:path'

export type ResolveTarget = 'bun' | 'browser'

const cache = new Map<string, string>()

// argv: [target, entry, spec]; prints the resolved path.
const PROBE = `
const [target, entry, spec] = process.argv.slice(1)
const source = 'import ' + JSON.stringify(spec) + '\\n'
let found
await Bun.build({
  entrypoints: [entry], target, write: false, files: { [entry]: source },
  plugins: [{ name: 'o', setup(b) { b.onLoad({ filter: /./ }, (a) => {
    if (a.path === entry) return { contents: source, loader: 'ts' }
    found ??= a.path
    return { contents: '', loader: 'js' }
  }) } }],
})
if (found) process.stdout.write(found)
`

/** `spec` as the bundler of `target` resolves it from the directory `from`. */
export function resolveNative(spec: string, from: string, target: ResolveTarget): string {
  const key = `${target}\0${from}\0${spec}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const r = Bun.spawnSync([process.execPath, '-e', PROBE, target, join(from, '__brust_resolve__.ts'), spec], { cwd: from, stdout: 'pipe', stderr: 'pipe' })
  const out = r.exitCode === 0 ? r.stdout.toString() : ''
  const path = out !== '' ? out : Bun.resolveSync(spec, from)
  cache.set(key, path)
  return path
}
