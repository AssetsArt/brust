import SecHead from './SecHead'

export default function Packages() {
  return (
    <section className="border-t border-rule py-18">
      <div className="mx-auto max-w-[1160px] px-4">
        <SecHead title="Packages" lede="Install only what the app uses. Everything publishes in lockstep at the same version." />
        <div className="border-t border-ink">
          <div className="grid grid-cols-[15rem_1fr_18rem] items-baseline gap-6 border-b border-rule py-4 max-wide:grid-cols-1 max-wide:gap-[.3rem] *:min-w-0">
            <code className="text-[15px] text-ink">@brust/core</code>
            <p className="text-[15px] text-ink-2">Routes, loaders, cache, actions, store, the CLI and the native server.</p>
            <span className="font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">bun add @brust/core</span>
          </div>
          <div className="grid grid-cols-[15rem_1fr_18rem] items-baseline gap-6 border-b border-rule py-4 max-wide:grid-cols-1 max-wide:gap-[.3rem] *:min-w-0">
            <code className="text-[15px] text-ink">@brust/create-app</code>
            <p className="text-[15px] text-ink-2">
              The scaffolder behind <code>bun create @brust/app</code>.
            </p>
            <span className="font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">bun create @brust/app@latest</span>
          </div>
          <div className="grid grid-cols-[15rem_1fr_18rem] items-baseline gap-6 border-b border-rule py-4 max-wide:grid-cols-1 max-wide:gap-[.3rem] *:min-w-0">
            <code className="text-[15px] text-ink">@brust/core-cf</code>
            <p className="text-[15px] text-ink-2">The same runtime as a Worker, used by the Cloudflare target.</p>
            <span className="font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">installed with @brust/core</span>
          </div>
          <div className="grid grid-cols-[15rem_1fr_18rem] items-baseline gap-6 border-b border-rule py-4 max-wide:grid-cols-1 max-wide:gap-[.3rem] *:min-w-0">
            <code className="text-[15px] text-ink">@brust/runtime-dom</code>
            <p className="text-[15px] text-ink-2">The browser runtime for native components: signals and bindings.</p>
            <span className="font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">installed with @brust/core</span>
          </div>
          <div className="grid grid-cols-[15rem_1fr_18rem] items-baseline gap-6 border-b border-rule py-4 max-wide:grid-cols-1 max-wide:gap-[.3rem] *:min-w-0">
            <code className="text-[15px] text-ink">@brust/cache-redis</code>
            <p className="text-[15px] text-ink-2">A shared cache tier on Redis or Dragonfly, with invalidation across instances.</p>
            <span className="font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">bun add @brust/cache-redis</span>
          </div>
          <div className="grid grid-cols-[15rem_1fr_18rem] items-baseline gap-6 border-b border-rule py-4 max-wide:grid-cols-1 max-wide:gap-[.3rem] *:min-w-0">
            <code className="text-[15px] text-ink">@brust/cache-cloudflare</code>
            <p className="text-[15px] text-ink-2">The shared tier on KV, with a Durable Object for invalidation.</p>
            <span className="font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">bun add @brust/cache-cloudflare</span>
          </div>
        </div>
      </div>
    </section>
  )
}
