import Counter from '../components/Counter'

export default function HomePage() {
  return (
    <>
      <header className="hero">
        <svg className="mark" viewBox="0 0 32 32" width="44" height="44" role="img" aria-label="brust">
          <rect width="32" height="32" rx="8" fill="#062323" />
          <path d="M7 19a9 9 0 0 1 18 0z" fill="#f2a516" />
          <rect x="5" y="20.5" width="22" height="2.2" rx="1.1" fill="#f2a516" />
          <rect x="10" y="24.6" width="12" height="2" rx="1" fill="#f2a516" opacity=".55" />
        </svg>
        <h1>brust app</h1>
      </header>
      <p className="lead">Edit pages/HomePage.tsx and save. The page reloads.</p>
      <section className="panel">
        <Counter />
        <p className="caption">useState only, so this button is native: a signal in the browser, no React shipped.</p>
      </section>
      <nav className="links" aria-label="Learn more">
        <a href="https://brust.dev">Docs</a>
        <a href="https://brust.dev/docs/routes">Routes</a>
        <a href="https://brust.dev/docs/actions">Actions</a>
      </nav>
    </>
  )
}
