'use server'
import { withMiddleware } from '../../runtime/index.ts'
import type { BrustRequest, Middleware } from '../../runtime/index.ts'

const requireUser: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return { status: 401, body: 'login required' }
  }
  return next()
}

/** Demo action: pretend to insert a note and return a generated id. */
export async function createNote(req: BrustRequest, text: string): Promise<{ id: string }> {
  if (typeof text !== 'string') throw new Error('text must be a string')
  if (text.length > 1000) throw new Error('text too long (max 1000)')
  return { id: 'n-' + Date.now() }
}

/** Demo action: returns whoever the `user` cookie says they are, or null. */
export async function whoAmI(req: BrustRequest): Promise<{ user: string | null }> {
  return { user: req.cookies['user'] ?? null }
}

/** Demo action: gated by requireUser middleware via the withMiddleware wrapper. */
export const deleteNote = withMiddleware(
  [requireUser],
  async (req: BrustRequest, noteId: string): Promise<{ ok: true }> => {
    if (typeof noteId !== 'string' || noteId.length === 0) {
      throw new Error('noteId must be a non-empty string')
    }
    return { ok: true }
  },
)

/** Demo action that returns nothing — exercises the empty-body wire path
 * (status 200, Content-Length: 0). Real use cases: fire-and-forget analytics
 * pings, log events. */
export async function pingAction(_req: BrustRequest): Promise<void> {
  // intentionally empty
}

/** Demo form action: receives a multipart FormData containing a `file` field.
 * Returns the file's name + size — no actual storage in the demo. */
export async function uploadAvatar(_req: BrustRequest, fd: FormData): Promise<{ name: string, size: number }> {
  const file = fd.get('file')
  if (!(file instanceof File)) throw new Error('file field required (multipart File)')
  if (file.size > 200 * 1024) throw new Error('file too big (max 200 KB)')
  return { name: file.name, size: file.size }
}

/** Probe action: returns the timestamp at which the SSE counter handler
 * last observed req.signal abort. Used by SSE integration test 3 to
 * confirm the client-disconnect → req.signal abort pipeline. The probe
 * relies on BRUST_WORKERS=1 in the test environment so the probe action
 * lands on the same JS context that ran the SSE handler. */
export async function lastSseAbort(_req: BrustRequest): Promise<{ ts: number }> {
  return { ts: (globalThis as { __lastSseAbort?: number }).__lastSseAbort ?? 0 }
}

/** Probe: returns the last WS close code/reason recorded by the ws-echo
 * handler. Used by integration test 7 (client clean close → on_close 1000).
 * Relies on BRUST_WORKERS=1 in the test env so the probe action lands on
 * the same JS context that ran the WS handler. */
export async function lastWsClose(_req: BrustRequest): Promise<{ code: number, reason: string }> {
  return (globalThis as { __lastWsClose?: { code: number, reason: string } }).__lastWsClose ?? { code: 0, reason: '' }
}
