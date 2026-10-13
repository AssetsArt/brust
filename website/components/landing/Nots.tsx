import SecHead from './SecHead'

export default function Nots() {
  return (
    <section className="border-t border-rule py-18">
      <div className="mx-auto max-w-[1160px] px-4">
        <SecHead title="What brust is not" lede="Fewer surprises if you know the shape before you start." />
        <div className="grid grid-cols-3 gap-10 max-wide:grid-cols-1 max-wide:gap-6">
          <div className="grid gap-[.4rem]">
            <h3 className="before:font-normal before:text-ink-2 before:content-['not_']">a single-page app</h3>
            <p className="text-ink-2">Navigation is server-first. Pages render on the server; islands hydrate only where they appear.</p>
          </div>
          <div className="grid gap-[.4rem]">
            <h3 className="before:font-normal before:text-ink-2 before:content-['not_']">file-system routing</h3>
            <p className="text-ink-2">
              Routes live in one explicit <code>routes.tsx</code>, so you can read the whole site in one file.
            </p>
          </div>
          <div className="grid gap-[.4rem]">
            <h3 className="before:font-normal before:text-ink-2 before:content-['not_']">a React replacement</h3>
            <p className="text-ink-2">Islands run real React 19. The compiler only steps in where React would be dead weight.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
