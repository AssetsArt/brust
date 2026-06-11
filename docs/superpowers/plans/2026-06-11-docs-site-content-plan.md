# Plan 2: docs site content (16 md pages)

Spec: `docs/superpowers/specs/2026-06-11-docs-site-md-design.md` §Content map +
§Content accuracy invariant (BINDING). Runs AFTER Plan 1 (shell live).

**Rules (every content task):**
- Write against the REAL API: every API claim verified against `runtime/` source or
  a repo test; the task report lists `claim → source file` for each page (report
  only, not in the page). Do NOT consult the old docs site or feat/docs-site.
- Frontmatter: `title`, `description`, `nav: { group: "...", order: N }` (index.md:
  no group, order 0).
- Style: plainspoken English; GFM tables for API surfaces (Property/Type/Default/
  Description columns, antd-class styling comes from app.css); fenced code with
  language tags (shiki); jinja-syntax examples in fences are SAFE (the pipeline
  neutralizes braces — that's the feature, use it confidently).
- Component tags must be top-level self-closing lines, literal props, outside
  fences; every embedded component must already be in routes.tsx registry
  (coordinate with the shell — markdown-pages.md embeds `<Counter …/>` and
  `<DemoBadge/>`; Plan 1 ships those components + registry entries by then or
  this task adds them following the three-identity rule).
- After each task: `bun run docs:dev` boot (cwd example/docs) → every new page 200,
  sidebar groups correct; `bun test tests/docs-site.test.ts`; `bun run ci`.
  Commits `docs(content): …` + Co-Authored-By line.

Primary sources per area (read FIRST, cite in report):
routing/loaders → runtime/routes.ts (Route/defineRoutes/loader ctx);
rendering modes → architecture.md + runtime/render/*;
native → runtime/native/* + crates docs comments + memory-verified constraints
(member-path/.map rules — verify against tests/fixtures);
store/signals → runtime/store/*; actions/treaty → runtime/define-actions.ts,
runtime/treaty.ts, runtime/action-error.ts; styling → runtime/css/* (Tailwind v4,
CSS Modules); md pages/SSG → runtime/md/*, runtime/cli/ssg.ts + the 0.1.40 spec;
CLI → runtime/cli/help.ts COMMANDS (the authoritative flag list);
agents/MCP → runtime/mcp/*; deployment → README + runtime/cli/build.ts targets.

## Task 2.1 — Getting Started (5 pages + rewrite index.md)

`index.md` (Overview: what brust is — Rust+Bun hybrid SSR, three rendering modes,
links per group), `introduction.md` (philosophy: native-first, islands,
when-to-use), `installation.md` (bun create brustjs, requirements, version
0.1.40-alpha), `first-route.md` (defineRoutes walkthrough, loader, params),
`project-structure.md` (scaffold layout, brust.toml, .brust/ cache),
`commands.md` (dev/build/new — from help.ts).

## Task 2.2 — Concepts I (3 pages)

`routing.md` (Route shape, nesting/Outlet, params `{slug}` matchit syntax, index
routes, middleware), `rendering.md` (React streaming vs native:true jinja vs
islands; when each; renderSlots note), `native-interactivity.md` (export const
behavior, x-* directives Scheme-1 no-colon, BehaviorCtx effect/onCleanup, auto
x-data, constraints: member-path/.map/inline-conditionals).

## Task 2.3 — Concepts II (3 pages)

`store.md` (signal/defineStore, server snapshot, isomorphic semantics),
`actions.md` (defineActions, treaty client, ActionError, standard-schema
validation), `styling.md` (app.css Tailwind v4, CSS Modules incl. native routes,
component css serving).

## Task 2.4 — Guides + Reference (4 pages)

`markdown-pages.md` — THE dogfood page: mdRoutes/mdNav full API, frontmatter,
embedding (LIVE `<Counter start={3} />` island demo + `<DemoBadge/>` behavior
demo embedded IN THIS PAGE), three-identity rule, brace-safety (show a fence
containing `{{ island_0_props }}` and `{% raw %}` text — eat the dogfood), SSG
section (`--ssg`, skip rules, root-path limitation, CF Pages walkthrough).
`deployment.md` (server deploy: build targets/platform packages, BRUST_* env,
workers; static: --ssg + CF Pages). `cli.md` (full command/flag reference from
help.ts, exact). `agents.md` (MCP manifest, brust mcp surface — from
runtime/mcp/* only; if thin, keep the page honest and short).

## Task 2.5 — consistency + cross-link pass

One agent reads ALL 16 rendered pages (dev server): heading hierarchy sane (one
h1), cross-links resolve (no 404s — script the check), terminology consistent
(native route / island / behavior component used identically), every fence has a
language tag, nav order reads logically. Fix inline. Update the 17-page count
assertion in tests/docs-site.test.ts to the exact final count.
