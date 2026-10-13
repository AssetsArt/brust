// lucide-react icons rendered at build time (L23). The compiler records an `IconRequest` for every
// icon it could inline; here each is rendered with `react-dom/server` (the app's own React and the
// installed lucide-react, so the markup is exactly what React would produce for that version),
// dynamic props rendered as sentinels the compiler lowers back to attributes. The result goes back
// with the next compile (`iconSvgs`). An icon that cannot be rendered keeps the L22 island.
import type { Compiled } from './compile'

interface Request {
  key: string
  source: string
  export: string
  props: Record<string, unknown>
  dynamic: string[]
  provider: Record<string, unknown>
  line: number
  col: number
}

const sentinel = (name: string) => `__BRUST_ICON_${name}__`

export interface IconMarkup {
  /** Dynamic props rendered as sentinels. */
  svg: string
  /** The same icon with the dynamic props absent: React's default for an `undefined` prop. */
  base: string
}

export async function renderIcons(compiled: Map<string, Compiled>, appRoot: string, log: (s: string) => void): Promise<Record<string, IconMarkup>> {
  const all: { c: Compiled; r: Request }[] = []
  for (const c of compiled.values()) for (const r of (c.ir.icon_requests ?? []) as Request[]) all.push({ c, r })
  if (all.length === 0) return {}
  // One React for the icon module and the renderer: both resolve from the app.
  const resolveFrom = (spec: string, from: string) => Bun.resolveSync(spec, from)
  const server = await import(resolveFrom('react-dom/server', appRoot))
  const react = await import(resolveFrom('react', appRoot))
  const out: Record<string, IconMarkup> = {}
  const mods = new Map<string, Record<string, unknown>>()
  for (const { c, r } of all) {
    const where = `${c.file.slice(appRoot.length + 1)}:${r.line}:${r.col}`
    try {
      let mod = mods.get(r.source)
      if (!mod) {
        mod = (await import(resolveFrom(r.source, appRoot))) as Record<string, unknown>
        mods.set(r.source, mod)
      }
      const Comp = mod[r.export] as unknown
      if (typeof Comp !== 'function' && (typeof Comp !== 'object' || Comp === null)) throw new Error(`${r.source} has no export \`${r.export}\``)
      const render = (dynamic: Record<string, unknown>): string => {
        let el = react.createElement(Comp, { ...r.props, ...dynamic })
        if (Object.keys(r.provider).length > 0) {
          const Provider = mod.LucideProvider
          if (!Provider) throw new Error(`${r.source} has no LucideProvider (the installed lucide-react predates it)`)
          el = react.createElement(Provider, r.provider, el)
        }
        const markup: string = server.renderToStaticMarkup(el)
        if (!markup.startsWith('<svg') || !markup.endsWith('</svg>')) throw new Error('it does not render an <svg>')
        if (/NaN|undefined/.test(markup)) throw new Error('a dynamic prop is combined with another (for example absoluteStrokeWidth with a dynamic size)')
        return markup
      }
      const svg = render(Object.fromEntries(r.dynamic.map((d) => [d, sentinel(d)])))
      for (const d of r.dynamic) if (!svg.includes(sentinel(d))) throw new Error(`prop \`${d}\` does not reach the markup`)
      // `size={undefined}` renders React's default (or the provider's value): render that too.
      out[r.key] = { svg, base: r.dynamic.length > 0 ? render({}) : svg }
    } catch (e) {
      log(`warning icon-render ${where} ${r.export} from ${r.source} stays a React island: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}
