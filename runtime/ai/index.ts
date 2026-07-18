/** Browser-only AI agent runtime. This standalone entry deliberately imports
 * neither runtime/index.ts nor runtime/routes.ts: both pull server/React code
 * into a browser bundle. Keep this module family React-free.
 */
import packageJson from '../../package.json' with { type: 'json' }
import * as actions from './actions.ts'
import { back, navigate, reload } from './navigate.ts'
import { pages } from './pages.ts'
import { struct } from './struct.ts'
import type { BrustError, ErrorResult } from './refs.ts'

type PublicMethod = (...args: never[]) => unknown

function envelope<T extends PublicMethod>(method: T): (...args: Parameters<T>) => Promise<unknown> {
  return async (...args: Parameters<T>) => {
    try {
      return await method(...args)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return {
        ok: false,
        error: { code: 'bad-input', message },
      } satisfies ErrorResult
    }
  }
}

function disabled(): Promise<ErrorResult> {
  return Promise.resolve({ ok: false, error: { code: 'disabled', message: 'P2' } })
}

export interface BrustRuntime {
  version: { api: 1; brust: string }
  pages: ReturnType<typeof envelope<typeof pages>>
  struct: ReturnType<typeof envelope<typeof struct>>
  action: {
    click: ReturnType<typeof envelope<typeof actions.click>>
    focus: ReturnType<typeof envelope<typeof actions.focus>>
    blur: ReturnType<typeof envelope<typeof actions.blur>>
    fill: ReturnType<typeof envelope<typeof actions.fill>>
    form: ReturnType<typeof envelope<typeof actions.form>>
    press: ReturnType<typeof envelope<typeof actions.press>>
    select: ReturnType<typeof envelope<typeof actions.select>>
    check: ReturnType<typeof envelope<typeof actions.check>>
  }
  navigate: ReturnType<typeof envelope<typeof navigate>>
  back: ReturnType<typeof envelope<typeof back>>
  reload: ReturnType<typeof envelope<typeof reload>>
  wait: typeof disabled
  state: typeof disabled
  nav: typeof disabled
  api: { list: typeof disabled; call: typeof disabled }
  errors: typeof disabled
}

export function createBrustRuntime(): BrustRuntime {
  return {
    version: { api: 1, brust: packageJson.version },
    pages: envelope(pages),
    struct: envelope(struct),
    action: {
      click: envelope(actions.click),
      focus: envelope(actions.focus),
      blur: envelope(actions.blur),
      fill: envelope(actions.fill),
      form: envelope(actions.form),
      press: envelope(actions.press),
      select: envelope(actions.select),
      check: envelope(actions.check),
    },
    navigate: envelope(navigate),
    back: envelope(back),
    reload: envelope(reload),
    wait: disabled,
    state: disabled,
    nav: disabled,
    api: { list: disabled, call: disabled },
    errors: disabled,
  }
}

declare global {
  interface Window {
    Brust: BrustRuntime
  }
}

if (typeof window !== 'undefined') window.Brust = createBrustRuntime()

export type { BrustError }
