// bench/lib/topology.ts — F595 D2: the server and the load generator never share a core. The PHYSICAL cores are split
// into a server set S and a generator set L; SMT siblings stay together on one side; every app runs in the same S.
// `parseLscpu` / `splitCores` are pure; `readTopology` reads the host (Linux: `lscpu -p`, else null = cannot pin).

export interface Core {
  /** physical core id (socket-qualified, so two sockets never merge) */
  id: string
  /** logical CPUs of this core (SMT siblings), sorted */
  cpus: number[]
}
export interface Split {
  /** logical CPUs the servers may use */
  server: number[]
  /** logical CPUs the load generator may use */
  gen: number[]
  serverCores: number
  genCores: number
}

/** `lscpu -p=CPU,CORE,SOCKET` → physical cores in first-seen order. Comment lines start with `#`. */
export function parseLscpu(text: string): Core[] {
  const byId = new Map<string, number[]>()
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const [cpu, core, socket] = t.split(',')
    const c = Number.parseInt(cpu ?? '', 10)
    if (!Number.isInteger(c) || core === undefined || core === '') throw new Error(`lscpu: cannot read the line "${t}"`)
    const id = `${socket || '0'}:${core}`
    const list = byId.get(id) ?? []
    list.push(c)
    byId.set(id, list)
  }
  return [...byId].map(([id, cpus]) => ({ id, cpus: cpus.sort((a, b) => a - b) }))
}

/** The last `genCores` physical cores go to the generator, the rest to the servers. A host with fewer than
 * `genCores + 1` physical cores cannot be split: that is an error, never a shared core. */
export function splitCores(cores: Core[], genCores: number): Split {
  if (!Number.isInteger(genCores) || genCores < 1) throw new Error(`the generator needs at least 1 physical core (got ${genCores})`)
  if (cores.length < genCores + 1)
    throw new Error(`cannot pin: ${cores.length} physical core(s), and the generator alone needs ${genCores} plus at least 1 for the servers`)
  const gen = cores.slice(cores.length - genCores)
  const server = cores.slice(0, cores.length - genCores)
  const flat = (xs: Core[]) => xs.flatMap((c) => c.cpus).sort((a, b) => a - b)
  return { server: flat(server), gen: flat(gen), serverCores: server.length, genCores: gen.length }
}

/** `0-3,8` style list for `taskset -c`. */
export function cpuList(cpus: number[]): string {
  const xs = [...new Set(cpus)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < xs.length; ) {
    let j = i
    while (j + 1 < xs.length && xs[j + 1] === (xs[j] as number) + 1) j++
    out.push(i === j ? `${xs[i]}` : `${xs[i]}-${xs[j]}`)
    i = j + 1
  }
  return out.join(',')
}

/** The host's physical cores, or null where the runner cannot pin (no `lscpu`, or no `taskset`: macOS). */
export function readTopology(): Core[] | null {
  if (process.platform !== 'linux' || !Bun.which('taskset') || !Bun.which('lscpu')) return null
  const r = Bun.spawnSync(['lscpu', '-p=CPU,CORE,SOCKET'], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) return null
  return parseLscpu(r.stdout.toString())
}
