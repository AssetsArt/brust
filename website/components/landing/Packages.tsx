export default function Packages() {
  return (
    <section className="sec">
      <div className="wrap">
        <div className="head">
          <h2>Packages</h2>
          <p>Install only what the app uses. Everything publishes in lockstep at the same version.</p>
        </div>
        <div className="pkgs">
          <div className="pkg">
            <code className="n">@brust/core</code>
            <p>Routes, loaders, cache, actions, store, the CLI and the native server.</p>
            <span className="how">bun add @brust/core</span>
          </div>
          <div className="pkg">
            <code className="n">@brust/create-app</code>
            <p>
              The scaffolder behind <code>bun create @brust/app</code>.
            </p>
            <span className="how">bun create @brust/app@latest</span>
          </div>
          <div className="pkg">
            <code className="n">@brust/core-cf</code>
            <p>The same runtime as a Worker, used by the Cloudflare target.</p>
            <span className="how">installed with @brust/core</span>
          </div>
          <div className="pkg">
            <code className="n">@brust/runtime-dom</code>
            <p>The browser runtime for native components: signals and bindings.</p>
            <span className="how">installed with @brust/core</span>
          </div>
          <div className="pkg">
            <code className="n">@brust/cache-redis</code>
            <p>A shared cache tier on Redis or Dragonfly, with invalidation across instances.</p>
            <span className="how">bun add @brust/cache-redis</span>
          </div>
          <div className="pkg">
            <code className="n">@brust/cache-cloudflare</code>
            <p>The shared tier on KV, with a Durable Object for invalidation.</p>
            <span className="how">bun add @brust/cache-cloudflare</span>
          </div>
        </div>
      </div>
    </section>
  )
}
