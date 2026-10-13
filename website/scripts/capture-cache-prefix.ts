// website/scripts/capture-cache-prefix.ts — runs every step of lib/cache-examples.ts against a REAL `brust start` (the fixture app in
// test/fixtures/cache-prefix, one worker, BUILD_ID=r1) and records the curl commands and what they printed in lib/cache-transcripts.json.
//   bun scripts/capture-cache-prefix.ts            # rewrite lib/cache-transcripts.json
// test/cache-prefix.test.ts runs capture() again and fails if the committed file no longer matches what the server does.
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPTURE_ENV, curlCommand, EXAMPLES, PROBES } from '../lib/cache-examples'

const site = join(import.meta.dir, '..')
const fixture = join(site, 'test/fixtures/cache-prefix')
const bin = join(site, '../packages/brust/bin/brust')

export interface Transcript {
  id: string
  steps: { command: string; output: string; outcome: string }[]
}

/** Builds the fixture, starts it (own PID, stopped at the end), runs each step with a real curl through `sh`, returns the transcripts. */
export async function capture(): Promise<Transcript[]> {
  const out = join(site, `dist-capture-${process.pid}`)
  rmSync(out, { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', out], { cwd: fixture, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0 || b.stderr.toString() !== '') throw new Error(`fixture build failed:\n${b.stdout.toString()}${b.stderr.toString()}`)
  const proc = Bun.spawn([bin, 'start', '--dist-dir', out, '--port', '0', '--workers', '1'], {
    cwd: fixture,
    env: { ...process.env, ...CAPTURE_ENV, BRUST_ADDR: '127.0.0.1', BRUST_PORT: '', BRUST_WORKERS: '', BRUST_DRAIN_TIMEOUT_MS: '1000' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    let log = ''
    while (!/\[brust\] ready/.test(log)) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`brust start exited before ready:\n${log}`)
      log += dec.decode(value, { stream: true })
    }
    const base = `http://${/listening on (\S+)/.exec(log)![1]}`
    void (async () => {
      for (;;) if ((await reader.read()).done) return
    })()
    const result: Transcript[] = []
    for (const ex of [...EXAMPLES, ...PROBES]) {
      const steps: Transcript['steps'] = []
      for (const s of ex.steps) {
        const command = curlCommand(ex, s)
        const r = Bun.spawnSync(['sh', '-c', command], { env: { ...process.env, BASE: base } })
        const output = r.stdout.toString().replaceAll('\r', '').trimEnd()
        const outcome = /x-brust-cache: (\S+)/.exec(output)?.[1] ?? ''
        if (outcome !== s.expect) throw new Error(`${ex.id}: ${command}\nexpected x-brust-cache ${s.expect}, the server sent ${outcome || '(none)'}\n${output}`)
        steps.push({ command, output, outcome })
      }
      result.push({ id: ex.id, steps })
    }
    return result
  } finally {
    proc.kill('SIGINT')
    if ((await Promise.race([proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) proc.kill('SIGKILL')
    await proc.exited
    rmSync(out, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const t = await capture()
  writeFileSync(join(site, 'lib/cache-transcripts.json'), `${JSON.stringify(t, null, 2)}\n`)
  console.log(`recorded ${t.length} examples, ${t.reduce((n, e) => n + e.steps.length, 0)} requests -> lib/cache-transcripts.json`)
}
