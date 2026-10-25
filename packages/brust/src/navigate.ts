// `navigate()` (SPA navigation, design §5.3): the types shared by the browser and server entries, and the server stub.
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean
}
export type NavTrigger = 'link' | 'navigate' | 'popstate'
/** `detail` of `brust:nav:load`. */
export interface NavLoadDetail { id: number; url: string; from: string; trigger: NavTrigger }
/** `detail` of `brust:nav:success`. */
export interface NavSuccessDetail extends NavLoadDetail { status: number }
/** `detail` of `brust:nav:error`: `swapped` tells whether a page (a 404, an error page) was swapped in anyway. */
export interface NavErrorDetail extends NavLoadDetail { status?: number; error?: unknown; swapped: boolean }

export function navigate(_url: string, _opts?: NavigateOptions): Promise<void> {
  throw new Error('navigate is browser-only (call it from a component or island running in the browser)')
}
