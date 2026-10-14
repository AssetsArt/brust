// `brust build [entry=routes.tsx] [--out-dir dist] [--force]` and
// `brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]`.
// Exit codes: 0 ok, 1 build/boot error (`error <rule> <message>` / `[brust] …`), 2 usage.
import { parseArgs } from 'node:util'
import { BuildError, runBuild } from './build'
import { runBunDev } from './dev/bun'
import { runDev } from './dev'
import { run } from './run'
import { shadcnInit, spawnRunner } from './shadcn/init'

const USAGE = `usage:
  brust build [entry=routes.tsx] [--out-dir dist] [--force] [--target bun|cloudflare|static] [--actions-only] [--strict] [--wasm-from-source] [--dev]
  brust dev [entry=routes.tsx] [--port N] [--workers N]    (Bun target: proxy + hot reload + inline TUI)
  brust dev [entry=routes.tsx] --target cloudflare [--out-dir dist] [--port N] [--wasm-from-source] [-- <wrangler args>]
  brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]
  brust shadcn init [component ...] [--force] [--css <file>] [--base-color <name>] [--shadcn-version <x.y.z>]

Config precedence for start: env (BRUST_ADDR, BRUST_PORT, BRUST_WORKERS, BRUST_RENDER_SLOTS,
BRUST_DRAIN_TIMEOUT_MS, BRUST_BOOT_TIMEOUT_MS, BRUST_DIST_DIR, BRUST_APP_ENTRY) > flags
(--port, --workers, --dist-dir, --entry) > brust.toml ([server] address/port, [workers] count)
> defaults (localhost:1337, one worker per CPU, 30 s boot timeout).
`

function usage(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`)
  process.exit(2)
}

/** A non-negative integer flag (`--port 0` = any free port). */
function intFlag(name: string, v: string | undefined, min: number): number | undefined {
  if (v === undefined) return undefined
  const n = /^\d+$/.test(v) ? Number.parseInt(v, 10) : Number.NaN
  if (!Number.isInteger(n) || n < min) usage(`--${name} must be an integer >= ${min} (got ${JSON.stringify(v)})`)
  return n
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...all] = argv
  const dd = cmd === 'dev' ? all.indexOf('--') : -1
  const rest = dd < 0 ? all : all.slice(0, dd)
  const passthrough = dd < 0 ? [] : all.slice(dd + 1)
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE)
    process.exit(cmd === undefined ? 2 : 0)
  }
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'out-dir': { type: 'string' },
        'dist-dir': { type: 'string' },
        entry: { type: 'string' },
        port: { type: 'string' },
        workers: { type: 'string' },
        force: { type: 'boolean' },
        css: { type: 'string' },
        'base-color': { type: 'string' },
        'shadcn-version': { type: 'string' },
        strict: { type: 'boolean' },
        target: { type: 'string' },
        'wasm-from-source': { type: 'boolean' },
        'actions-only': { type: 'boolean' },
        dev: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    usage((e as Error).message)
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  const str = (k: string) => values[k] as string | undefined
  const target = str('target')
  if (target !== undefined && target !== 'bun' && target !== 'cloudflare' && target !== 'static')
    usage(`--target must be bun, cloudflare or static (got ${JSON.stringify(target)})`)
  if (values['actions-only'] === true && cmd !== 'build') usage('--actions-only only applies to brust build')
  if (values.strict === true && (cmd !== 'build' || target !== 'static')) usage('--strict only applies to brust build --target static')

  if (cmd === 'build') {
    if (positionals.length > 1) usage(`build takes one entry (got ${positionals.join(' ')})`)
    const t0 = performance.now()
    try {
      await runBuild({
        appRoot: process.cwd(),
        entry: positionals[0] ?? 'routes.tsx',
        outDir: str('out-dir') ?? 'dist',
        force: values.force === true,
        target: target as 'bun' | 'cloudflare' | 'static' | undefined,
        strict: values.strict === true,
        wasmFromSource: values['wasm-from-source'] === true,
        actionsOnly: values['actions-only'] === true,
        dev: values.dev === true,
        log: (s) => console.log(s),
      })
    } catch (e) {
      if (e instanceof BuildError) console.error(`error ${e.rule} ${e.message}`)
      else if (e instanceof AggregateError) console.error(`error build ${e.message}\n${e.errors.map(String).join('\n')}`)
      else console.error(`error build ${(e as Error).stack ?? String(e)}`)
      process.exit(1)
    }
    console.log(`[brust] built ${str('out-dir') ?? 'dist'} in ${Math.round(performance.now() - t0)}ms`)
    process.exit(0)
  }
  if (cmd === 'dev') {
    if (positionals.length > 1) usage(`dev takes one entry (got ${positionals.join(' ')})`)
    const port = intFlag('port', str('port'), 0)
    if (target !== 'cloudflare') {
      const workers = intFlag('workers', str('workers'), 1)
      if (passthrough.length > 0) usage('brust dev: arguments after -- are for --target cloudflare (wrangler)')
      process.exit(await runBunDev({ appRoot: process.cwd(), entry: positionals[0] ?? 'routes.tsx', ...(port !== undefined && { port }), ...(workers !== undefined && { workers }) }))
    }
    try {
      process.exit(
        await runDev({
          appRoot: process.cwd(),
          entry: positionals[0] ?? 'routes.tsx',
          outDir: str('out-dir') ?? 'dist',
          ...(port !== undefined && { port }),
          wranglerArgs: passthrough,
          fromSource: values['wasm-from-source'] === true,
          log: (s) => console.log(s),
        }),
      )
    } catch (e) {
      if (e instanceof BuildError) console.error(`error ${e.rule} ${e.message}`)
      else console.error(`error dev ${(e as Error).stack ?? String(e)}`)
      process.exit(1)
    }
  }
  if (cmd === 'shadcn') {
    const [sub, ...components] = positionals
    if (sub !== 'init') usage(`shadcn takes a subcommand: init (got ${sub === undefined ? 'none' : JSON.stringify(sub)})`)
    const code = await shadcnInit({
      root: process.cwd(),
      components,
      force: values.force === true,
      ...(str('css') !== undefined && { css: str('css') }),
      ...(str('base-color') !== undefined && { baseColor: str('base-color') }),
      ...(str('shadcn-version') !== undefined && { shadcnVersion: str('shadcn-version') }),
      run: spawnRunner,
      out: (s) => console.log(s),
    })
    process.exit(code)
  }
  if (cmd === 'start') {
    if (positionals.length > 0) usage(`start takes no positional arguments (got ${positionals.join(' ')})`)
    const port = intFlag('port', str('port'), 0)
    const workers = intFlag('workers', str('workers'), 1)
    await run({
      distDir: str('dist-dir'),
      entry: str('entry'),
      config: { ...(port !== undefined && { port }), ...(workers !== undefined && { workers }) },
    })
    return
  }
  usage(`unknown command ${cmd}`)
}

if (import.meta.main) await main(process.argv.slice(2))
