// "Data stays next to the route": the route entry and the invalidate call, with the numbered pins that tie them to the list.
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'

export default function DataSection({ route, invalidate }: { route: CodeBlockData; invalidate: CodeBlockData }) {
  return (
    <section className="border-t border-rule py-18">
      <div className="mx-auto grid max-w-[1160px] grid-cols-[1fr_1.25fr] items-start gap-12 px-4 max-wide:grid-cols-1 *:min-w-0">
        <div className="grid gap-[1.1rem]">
          <h2>Data stays next to the route</h2>
          <p className="text-ink-2">
            Each route names its loader, and layouts nest through <code>Outlet</code> with their loader results merged top-down.
          </p>
          <ol className="m-0 grid list-none gap-[.8rem] p-0">
            <li className="grid grid-cols-[1.5rem_1fr] gap-[.6rem] text-ink-2">
              <span className="mt-[.15rem] inline-grid size-5 place-items-center rounded-full bg-amber-fill text-[11px] text-on-amber select-none">1</span>
              <span>
                <b className="font-semibold text-ink">Params arrive decoded</b>, including encoded slashes.
              </span>
            </li>
            <li className="grid grid-cols-[1.5rem_1fr] gap-[.6rem] text-ink-2">
              <span className="mt-[.15rem] inline-grid size-5 place-items-center rounded-full bg-amber-fill text-[11px] text-on-amber select-none">2</span>
              <span>
                <b className="font-semibold text-ink">The loader runs in Bun</b> with the request in hand and returns the page's props.
              </span>
            </li>
            <li className="grid grid-cols-[1.5rem_1fr] gap-[.6rem] text-ink-2">
              <span className="mt-[.15rem] inline-grid size-5 place-items-center rounded-full bg-amber-fill text-[11px] text-on-amber select-none">3</span>
              <span>
                <b className="font-semibold text-ink">Caching is one line.</b> A hit is answered by Rust and never wakes Bun.
              </span>
            </li>
            <li className="grid grid-cols-[1.5rem_1fr] gap-[.6rem] text-ink-2">
              <span className="mt-[.15rem] inline-grid size-5 place-items-center rounded-full bg-amber-fill text-[11px] text-on-amber select-none">4</span>
              <span>
                <b className="font-semibold text-ink">Invalidate by tag</b> from wherever the data changed.
              </span>
            </li>
          </ol>
        </div>
        <div className="grid gap-[.9rem]">
          <CodeBlock code={route.code} lang={route.lang} file={route.file} cwd={route.cwd} html={route.html} />
          <CodeBlock code={invalidate.code} lang={invalidate.lang} file={invalidate.file} cwd={invalidate.cwd} html={invalidate.html} />
        </div>
      </div>
    </section>
  )
}
