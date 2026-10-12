export default function Nots() {
  return (
    <section className="sec">
      <div className="wrap">
        <div className="head">
          <h2>What brust is not</h2>
          <p>Fewer surprises if you know the shape before you start.</p>
        </div>
        <div className="nots">
          <div>
            <h3>a single-page app</h3>
            <p>Navigation is server-first. Pages render on the server; islands hydrate only where they appear.</p>
          </div>
          <div>
            <h3>file-system routing</h3>
            <p>
              Routes live in one explicit <code>routes.tsx</code>, so you can read the whole site in one file.
            </p>
          </div>
          <div>
            <h3>a React replacement</h3>
            <p>Islands run real React 19. The compiler only steps in where React would be dead weight.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
