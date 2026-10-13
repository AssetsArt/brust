import Counter from '../components/Counter'

const link = 'font-semibold text-amber-ink underline underline-offset-[0.2em] hover:decoration-2 focus-visible:rounded focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-amber-ink'

export default function HomePage() {
  return (
    <>
      <header className="flex items-center gap-[0.9rem]">
        <svg className="flex-none" viewBox="0 0 32 32" width="44" height="44" aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#062323" />
          <path d="M7 19a9 9 0 0 1 18 0z" fill="#f2a516" />
          <rect x="5" y="20.5" width="22" height="2.2" rx="1.1" fill="#f2a516" />
          <rect x="10" y="24.6" width="12" height="2" rx="1" fill="#f2a516" opacity=".55" />
        </svg>
        <h1 className="m-0 text-4xl leading-[1.1] font-bold tracking-[-0.01em]">brust app</h1>
      </header>
      <p className="mt-4 mb-8 text-lg text-ink-2">Edit pages/HomePage.tsx and save. The page reloads.</p>
      <section className="rounded-2xl border border-rule bg-sheet p-6">
        <Counter />
        <p className="mt-4 mb-0 text-[0.9375rem] text-ink-2">useState only, so this button is native: a signal in the browser, no React shipped.</p>
      </section>
      <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2" aria-label="Learn more">
        <a className={link} href="https://brust.dev">
          Docs
        </a>
        <a className={link} href="https://brust.dev/docs/routing">
          Routes
        </a>
        <a className={link} href="https://brust.dev/docs/actions">
          Actions
        </a>
      </nav>
    </>
  )
}
