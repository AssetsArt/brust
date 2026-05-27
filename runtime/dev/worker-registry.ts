const TERMINATE_TIMEOUT_MS = 2000

interface RegistryState {
  workers: Worker[]
  entry: string | null
  count: number
  baseEnv: Record<string, string> | null
}

const state: RegistryState = {
  workers: [],
  entry: null,
  count: 0,
  baseEnv: null,
}

/** Called once by brust.serve() in dev mode AFTER it spawns the initial
 * pool. Hands the references to the registry so the coordinator can
 * churn them later. */
export function registerInitialPool(
  workers: Worker[],
  entry: string,
  count: number,
  baseEnv: Record<string, string>,
): void {
  state.workers = workers.slice()
  state.entry = entry
  state.count = count
  state.baseEnv = baseEnv
}

/** Terminate every Worker with a 2s per-worker grace. If termination
 * doesn't return in time, abandon the reference and continue. */
export async function terminateAll(): Promise<void> {
  const olds = state.workers
  state.workers = []
  await Promise.all(olds.map(async (w) => {
    try {
      await Promise.race([
        w.terminate(),
        new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_TIMEOUT_MS)),
      ])
    } catch {
      // Already-terminated rejections swallowed.
    }
  }))
}

/** Spawn `count` fresh Workers using the entry + env captured at
 * registerInitialPool time. Each worker gets BRUST_WORKER_ID=i.
 * Workers self-register their renderers with Rust on import (existing
 * brust.run worker branch behavior). */
export function spawnAll(): void {
  if (state.entry === null || state.baseEnv === null) {
    throw new Error('worker-registry: spawnAll called before registerInitialPool')
  }
  const fresh: Worker[] = []
  for (let i = 0; i < state.count; i++) {
    const w = new Worker(state.entry, {
      env: { ...state.baseEnv, BRUST_WORKER_ID: String(i) },
    })
    fresh.push(w)
  }
  state.workers = fresh
}

/** Test helper. */
export function _workersForTests(): Worker[] { return [...state.workers] }
export function _resetForTests(): void {
  state.workers = []
  state.entry = null
  state.count = 0
  state.baseEnv = null
}
