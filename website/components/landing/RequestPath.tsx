// "What happens to one request": the serving path of a real route on this site (/demo/pokemon/{name}, cached 60 s),
// step by step, with a MISS/HIT switch that dims what a cache hit skips. Steps follow pages/docs/Introduction.tsx#request.
import { useState } from 'react'

export default function RequestPath() {
  const [hit, setHit] = useState(false)
  return (
    <section className="sec reqsec">
      <div className="wrap">
        <div className="head">
          <h2>What happens to one request</h2>
          <p>Rust receives every request and writes every response. Bun runs your loaders, and is skipped when the cache already has the page.</p>
        </div>
        <div className="reqbar">
          <code>GET /demo/pokemon/pikachu</code>
          <div className="seg" role="group" aria-label="Cache state">
            <button type="button" aria-pressed={!hit} onClick={() => setHit(false)}>
              First request
            </button>
            <button type="button" aria-pressed={hit} onClick={() => setHit(true)}>
              Again within 60 s
            </button>
          </div>
        </div>
        <ol className={hit ? 'reqpath hit' : 'reqpath'}>
          <li>
            <span className="who rust">Rust</span>
            <h3>Match the route</h3>
            <p>
              <code>/demo/pokemon/{'{name}'}</code>, with <code>name = pikachu</code>.
            </p>
          </li>
          <li>
            <span className="who rust">Rust</span>
            <h3>Check the cache</h3>
            <p className="on-miss">Nothing stored yet for this URL.</p>
            <p className="on-hit">A fresh copy is in memory. It is sent as is.</p>
          </li>
          <li className="skip">
            <span className="who bun">Bun</span>
            <h3>Run the loaders</h3>
            <p>Layout first, then the page. Their results become the page's props.</p>
          </li>
          <li className="skip">
            <span className="who rust">Rust</span>
            <h3>Render the page</h3>
            <p>From templates compiled at build time, then stored for 60 seconds.</p>
          </li>
          <li>
            <span className="who browser">Browser</span>
            <h3>Gets HTML</h3>
            <p>
              <span className="on-miss">
                <code>x-brust-cache: MISS</code>.
              </span>
              <span className="on-hit">
                <code>x-brust-cache: HIT</code>.
              </span>{' '}
              No script tag: nothing on this page is interactive.
            </p>
          </li>
        </ol>
      </div>
    </section>
  )
}
