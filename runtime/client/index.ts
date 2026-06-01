/** Browser-only client helpers. This module is loaded by hydrated island
 * bundles. It intentionally does NOT import from runtime/routes.ts or
 * runtime/index.ts — those pull in React and server-side surface that the
 * client doesn't need.
 */

// BrustActionError is kept for backward compatibility with tests/fixtures/app
// (AvatarUpload.tsx, NoteForm.tsx, WhoAmI.tsx) until Task M1 migrates those
// usages to the new treaty client.
export class BrustActionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message)
    this.name = 'BrustActionError'
  }
}

export { client } from '../treaty.ts'
export type { TreatyResponse, ClientOptions } from '../treaty.ts'
