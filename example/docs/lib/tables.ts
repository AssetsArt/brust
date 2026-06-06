// Data for the API/reference tables. Rendered by pages as an in-page `.map()` over
// `{ columns, rows }` (native x-for SSR) — column typography is handled by CSS
// nth-child in app.css (`.b-table`), so the template stays branch-free per cell.
// All rows describe the REAL brust API (verified against runtime/).

export interface TableData {
  columns: string[]
  rows: { cells: string[] }[]
}

const t = (columns: string[], rows: string[][]): TableData => ({
  columns,
  rows: rows.map((cells) => ({ cells })),
})

// ── Project structure ──────────────────────────────────────────────────────────
export const keyFiles = t(
  ['File', 'Role'],
  [
    ['index.ts', 'The entry — calls brust.run({ routes, actions, entry }).'],
    ['routes.tsx', 'Exports defineRoutes([...]). The single source of truth for the route table.'],
    ['actions.ts', 'Exports defineActions(). Each handler is a typed endpoint and an MCP tool.'],
    ['app.css', 'Tailwind v4 entry. @import "tailwindcss" plus your @theme tokens.'],
    ['brust.toml', 'Optional server config — address, port, worker count.'],
    ['public/', 'Static files served directly by the Rust layer, bypassing JS.'],
  ],
)

// ── Routing ────────────────────────────────────────────────────────────────────
export const routeFields = t(
  ['Field', 'Type', 'Default', 'Description'],
  [
    ['path', 'string', '—', 'URL segment. Use :param for a dynamic segment.'],
    ['index', 'boolean', 'false', "Matches the parent's path exactly. Must be a leaf."],
    ['Component', 'ComponentType', '—', 'The React (or native) component to render.'],
    [
      'native',
      'boolean',
      'false',
      'Compile to a minijinja template, render in Rust. No client JS.',
    ],
    ['loader', 'function', '—', "Async server function; its return becomes the component's props."],
    ['middleware', 'Middleware[]', '[]', 'Request-scoped functions that run before the loader.'],
    ['cache', 'RouteCacheConfig', '—', 'ISR — cache the rendered HTML for ttl_seconds.'],
    ['children', 'Route[]', '—', "Nested routes rendered into this route's <Outlet/>."],
  ],
)

export const routeStreaming = t(
  ['Field', 'Type', 'Description'],
  [
    [
      'sse',
      '(req) => ReadableStream',
      'Stream a text/event-stream response (auto Content-Type + heartbeat).',
    ],
    [
      'websocket',
      '() => Promise<WsHandlers>',
      'Accept WebSocket upgrades; open / message / close handlers.',
    ],
    [
      'errorBoundary',
      'ComponentType',
      'Rendered when the Component or loader throws (inherited by children).',
    ],
  ],
)

// ── Rendering ──────────────────────────────────────────────────────────────────
export const modeCompare = t(
  ['Mode', 'Server', 'Client JS', 'Use for'],
  [
    ['native: true', 'Rust template', '0 kb', 'Marketing, content, mostly-static pages'],
    ['streaming SSR', 'React 19', 'Route + islands', 'Data-heavy app screens with Suspense'],
    ['island', 'React', 'Per-component chunk', 'Isolated interactive widgets in a static page'],
  ],
)

// ── Native interactivity ────────────────────────────────────────────────────────
export const directiveRef = t(
  ['Directive', 'Does'],
  [
    ['x-data', 'Declares a reactive scope (auto-injected when a behavior is present).'],
    ['x-text', 'Sets textContent from a signal or expression.'],
    ['x-show', 'Toggles display based on a boolean signal/computed.'],
    ['x-bind-attr', 'Binds any attribute (x-bind-class, x-bind-href, …).'],
    ['x-on-event', 'Attaches an event handler (x-on-click, x-on-input, …).'],
    ['x-for', 'Repeats an element over a list, keyed by item.'],
  ],
)

export const ctxMembers = t(
  ['Member', 'Type', 'Description'],
  [
    ['ctx.el', 'HTMLElement', 'The root element the behavior is attached to.'],
    ['ctx.props', 'object', 'Props passed to the component instance.'],
    [
      'ctx.effect(fn)',
      '(fn) => dispose',
      'Runs fn after mount; re-runs when its reactive reads change.',
    ],
    [
      'ctx.onCleanup(fn)',
      '(fn) => void',
      'Registers teardown — runs on unmount / before an effect re-runs.',
    ],
  ],
)

// ── Store ──────────────────────────────────────────────────────────────────────
export const storePrimitives = t(
  ['Function', 'Signature', 'Description'],
  [
    [
      'signal(initial)',
      '(T) => Signal<T>',
      'Readable/writable reactive value. Read sig(), write sig.set(v).',
    ],
    [
      'computed(fn)',
      '(() => T) => Computed<T>',
      'Derived, read-only signal. Recomputes lazily on change.',
    ],
    [
      'effect(fn)',
      '(() => void) => Dispose',
      'Runs now and re-runs on change. Return a cleanup, or dispose it.',
    ],
    ['batch(fn)', '(() => void) => void', 'Coalesce multiple writes into one notification.'],
  ],
)

// ── CLI ────────────────────────────────────────────────────────────────────────
export const cliCommands = t(
  ['Command', 'Description'],
  [
    [
      'brust dev <entry>',
      'Start the dev server with hot reload and on-the-fly native compilation.',
    ],
    [
      'brust build <entry>',
      'Compile native routes, bundle islands, build MCP manifest, emit dist/.',
    ],
    ['brust new <name>', 'Scaffold a new app (same as bun create brustjs).'],
  ],
)

// ── Deployment ─────────────────────────────────────────────────────────────────
export const deployTargets = t(
  ['Target', 'libc', 'Notes'],
  [
    ['linux-x64-gnu', 'glibc', 'Default for most cloud VMs and managed runtimes.'],
    ['linux-x64-musl', 'musl', 'Alpine and distroless images. Static server binary.'],
    ['linux-arm64-gnu', 'glibc', 'Graviton / Ampere and arm64 hosts.'],
    ['darwin-arm64', '—', 'Local production runs on Apple Silicon.'],
  ],
)
