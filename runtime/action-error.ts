// Typed domain error for treaty actions. `throw new ActionError(status, code, { data })`
// from a handler (or nested business logic) → dispatchAction maps it to an HTTP
// non-2xx with a flat body `{ code, message, data }`. Branded with Symbol.for so the
// guard survives the class being duplicated across bundles (user code → framework).
const ACTION_ERROR: unique symbol = Symbol.for('brust.actionError')

export interface ActionErrorBody {
  code: string
  message: string
  data?: unknown
}

export class ActionError extends Error {
  readonly [ACTION_ERROR] = true as const
  readonly status: number
  readonly code: string
  readonly data?: unknown
  constructor(status: number, code: string, opts?: { message?: string; data?: unknown }) {
    super(opts?.message ?? code)
    this.name = 'ActionError'
    this.status = status
    this.code = code
    this.data = opts?.data
  }
}

export function isActionError(v: unknown): v is ActionError {
  return (
    typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[ACTION_ERROR] === true
  )
}
