// `brust build [entry=routes.tsx] [--out-dir dist]` and
// `brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]`.
// Exit codes: 0 ok, 1 build/boot error (`error <rule> <message>` / `[brust] …`), 2 usage.
import { parseArgs } from 'node:util'
import { BuildError, runBuild } from './build'
import { run } from './run'

const USAGE = `usage:
  brust build [entry=routes.tsx] [--out-dir dist]
  brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]

Config precedence for start: env (BRUST_ADDR, BRUST_PORT, BRUST_WORKERS, BRUST_RENDER_SLOTS,
BRUST_DRAIN_TIMEOUT_MS, BRUST_DIST_DIR) > flags > brust.toml ([server] address/port,
[workers] count) > defaults (localhost:1337, one worker per CPU).
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
  const [cmd, ...rest] = argv
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

  if (cmd === 'build') {
    if (positionals.length > 1) usage(`build takes one entry (got ${positionals.join(' ')})`)
    const t0 = performance.now()
    try {
      await runBuild({ appRoot: process.cwd(), entry: positionals[0] ?? 'routes.tsx', outDir: str('out-dir') ?? 'dist', log: (s) => console.log(s) })
    } catch (e) {
      if (e instanceof BuildError) console.error(`error ${e.rule} ${e.message}`)
      else if (e instanceof AggregateError) console.error(`error build ${e.message}\n${e.errors.map(String).join('\n')}`)
      else console.error(`error build ${(e as Error).stack ?? String(e)}`)
      process.exit(1)
    }
    console.log(`[brust] built ${str('out-dir') ?? 'dist'} in ${Math.round(performance.now() - t0)}ms`)
    process.exit(0)
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
