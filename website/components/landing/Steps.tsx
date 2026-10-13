// "Sixty seconds to a served page": a numbered rail whose fill follows the scroll.
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'
import RailFill from './RailFill'
import SecHead from './SecHead'

export default function Steps({ create, write, run }: { create: CodeBlockData; write: CodeBlockData; run: CodeBlockData }) {
  return (
    <section className="border-t border-rule py-18">
      <div className="mx-auto max-w-[1160px] px-4">
        <SecHead title="Sixty seconds to a served page" lede="No config to write first. The template already has a layout, a page and the scripts." />
        <ol className="relative m-0 grid list-none gap-10 p-0 pl-[3.25rem] before:absolute before:top-[.4rem] before:bottom-[.4rem] before:left-[1.05rem] before:w-[2px] before:bg-rule before:content-['']" id="rail">
          <RailFill />
          <li className="relative grid grid-cols-[1fr_1.4fr] items-start gap-8 max-wide:grid-cols-1 max-wide:gap-[.9rem]">
            <span className="absolute top-0 -left-[3.25rem] z-10 grid size-[2.2rem] place-items-center rounded-full bg-amber-fill font-mono text-[14px] text-on-amber">1</span>
            <div className="grid min-w-0 gap-2">
              <h3>Create</h3>
              <p className="text-ink-2">One command scaffolds the project and installs its dependencies.</p>
            </div>
            <CodeBlock code={create.code} lang={create.lang} file={create.file} cwd={create.cwd} html={create.html} />
          </li>
          <li className="relative grid grid-cols-[1fr_1.4fr] items-start gap-8 max-wide:grid-cols-1 max-wide:gap-[.9rem]">
            <span className="absolute top-0 -left-[3.25rem] z-10 grid size-[2.2rem] place-items-center rounded-full bg-amber-fill font-mono text-[14px] text-on-amber">2</span>
            <div className="grid min-w-0 gap-2">
              <h3>Write</h3>
              <p className="text-ink-2">A page is a React component. There is nothing to import from brust.</p>
            </div>
            <CodeBlock code={write.code} lang={write.lang} file={write.file} cwd={write.cwd} html={write.html} />
          </li>
          <li className="relative grid grid-cols-[1fr_1.4fr] items-start gap-8 max-wide:grid-cols-1 max-wide:gap-[.9rem]">
            <span className="absolute top-0 -left-[3.25rem] z-10 grid size-[2.2rem] place-items-center rounded-full bg-amber-fill font-mono text-[14px] text-on-amber">3</span>
            <div className="grid min-w-0 gap-2">
              <h3>Run</h3>
              <p className="text-ink-2">Build compiles every component; start serves them from Rust.</p>
            </div>
            <CodeBlock code={run.code} lang={run.lang} file={run.file} cwd={run.cwd} html={run.html} />
          </li>
        </ol>
      </div>
    </section>
  )
}
