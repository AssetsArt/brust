// Public, typed facade over the native `compileJsx` NAPI binding. The native fn
// takes (source, path, componentSources?, lucideIcons?, directiveNames?) — this
// facade exposes the common 2-arg form for compiling a single self-contained
// component (custom sections, tooling). `path` is the source location used as
// the prefix in compiler error messages (e.g. "shop/42/section/7:0:0: …").
// THROWS on invalid source (verified under Bun — unlike the fallible
// napiRegister* bindings, compileJsx propagates a real throw, not a returned
// Error). Mirrors the `templates.ts` wrapper pattern.
import * as native from './index.js'

export interface CompileJsxResult {
  /** Compiled minijinja template. Interpolations are auto-escaped (`| e`). */
  template: string
  /** Island manifest JSON — `"[]"` when the component references no <Island>. */
  islandsJson: string
  /** SSR-component manifest JSON — `"[]"` when none. */
  componentsJson: string
  /** Non-fatal compiler diagnostics. */
  warnings: string[]
}

export function compileJsx(source: string, path: string): CompileJsxResult {
  return (
    native as unknown as { compileJsx(source: string, path: string): CompileJsxResult }
  ).compileJsx(source, path)
}
