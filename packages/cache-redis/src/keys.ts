// The key schema (cache-redis R1): every key of a namespace carries the cluster hash tag
// `{brust:<ns>}`, so the multi-key scripts stay on one slot. Only page keys are build-scoped
// (their L2 key carries the build); index sets, markers, seq and the channel are namespace-level.
import type { InvalidateArgs } from '@brust/core/cache-adapter'

export interface Keys {
  page(l2Key: string): string
  tag(tag: string): string
  path(method: string | undefined, path: string): string
  markTag(tag: string): string
  markPath(method: string | undefined, path: string): string
  seq: string
  stage(id: string): string
  channel: string
  /** SCAN pattern of every key of the namespace. */
  all: string
}

const pathName = (method: string | undefined, path: string) => `${(method ?? 'GET').toUpperCase()} ${path}`

export function keys(ns: string): Keys {
  const p = `{brust:${ns}}`
  return {
    page: (k) => `${p}:page:${k}`,
    tag: (t) => `${p}:tag:${t}`,
    path: (m, path) => `${p}:path:${pathName(m, path)}`,
    markTag: (t) => `${p}:inval:tag:${t}`,
    markPath: (m, path) => `${p}:inval:path:${pathName(m, path)}`,
    seq: `${p}:seq`,
    stage: (id) => `${p}:stage:${id}`,
    channel: `brust:${ns}:inval`,
    all: `${p}:*`,
  }
}

/** Order- and case-insensitive identity of an invalidation (pairs its store and broadcast halves). */
export function canonical(a: InvalidateArgs): string {
  return JSON.stringify({
    tags: [...new Set(a.tags ?? [])].sort(),
    ...(a.path !== undefined ? { path: a.path, method: (a.method ?? 'GET').toUpperCase() } : {}),
  })
}

/** Does the invalidation touch pages? (A key-only one is tier 1's business: the store holds none by key.) */
export function hasStoreWork(a: InvalidateArgs): boolean {
  return (a.tags?.length ?? 0) > 0 || a.path !== undefined
}
