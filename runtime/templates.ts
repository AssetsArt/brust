// R1 dynamic template registry — runtime registration of minijinja templates
// (per-tenant sections etc.). Thin TS over NAPI; the Rust env is process-global
// so registrations are visible to every worker isolate immediately.
import * as native from './index.js'

export const templates = {
  /** Register (or replace) a runtime template under `name`. Names are opaque
   * keys (`shop/42/section/7@v3` is fine). Throws on jinja syntax errors
   * (message includes line info). Replacement is atomic: concurrent renders
   * see old or new, never missing. */
  register(name: string, jinjaSource: string): void {
    // napi-rs v3 hands back the `Error` as the RETURN VALUE for sync
    // fallible bindings under Bun instead of throwing (verified empirically
    // for both `Result<()>` and `Result<String>`) — normalize to the
    // documented throw.
    const err = (native as any).napiRegisterTemplate(name, jinjaSource)
    if (err instanceof Error) throw err
  },
  /** Remove a runtime-registered template. Returns whether it existed.
   * Boot-tier templates (compiled from routes) are not removable. */
  remove(name: string): boolean {
    return (native as any).napiRemoveTemplate(name)
  },
  /** True when `name` resolves in either tier (dynamic first, then boot). */
  has(name: string): boolean {
    return (native as any).napiHasTemplate(name)
  },
  /** Names of runtime-registered templates (dynamic tier only). */
  list(): string[] {
    return (native as any).napiListDynamicTemplates() ?? []
  },
  /** Render a template (either tier) to an HTML string. Pure (name, data) →
   * html — no request/store context. NOT the request fast lane; intended for
   * handlers/loaders/tooling (draft canvases, section previews). */
  render(name: string, data?: unknown): string {
    // `data == null` (undefined OR explicit null) renders against an empty
    // context — JSON.stringify(null) would hand minijinja a null root where
    // every variable lookup goes Undefined.
    const json = JSON.stringify(data == null ? {} : data)
    // Same napi-rs v3 Bun quirk as register(): the Error comes back as the
    // return value, not a throw — without this guard a consumer would
    // interpolate "Error: ..." into HTML instead of catching.
    const out = (native as any).napiRenderTemplate(name, json)
    if (out instanceof Error) throw out
    return out
  },
}
