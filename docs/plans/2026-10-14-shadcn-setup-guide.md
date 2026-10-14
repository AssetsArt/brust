# shadcn/ui setup guide for brust projects (L35)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: first free implementer (coordinator assigns) · reviewer: Afrojack · gates: Illenium · flow: lane → PR → CI → lead merges + deploys brust.dev · ledger row: F160 · depends on: `icon-shapes` (F159, R34.76 tsconfig `paths` alias) for the `@/` import section

## Why

Human order, 2026-10-14: "ขอ setup Guide ของ shadcn ลงใน brust project ด้วย". The site explains what compiles (`/docs/shadcn`) but not how to get shadcn/ui into a brust app. The guide must be a path a new user can follow start to finish and end with a page that builds, serves and hydrates.

## Requirements

- **R38.1 Verified, not written from memory.** Every step is executed on a fresh `bun create @brust/app` project in a scratch directory with the published `@brust/*` version and the real shadcn CLI (`bunx shadcn@latest`). The PR attaches the transcript path (commands + output) and the built page's tier/JS numbers. Any step that fails is either fixed in brust (separate lane, ledger row) or documented as a workaround, never hidden.
- **R38.2 What the guide covers.** Prerequisites (Bun, the version); `components.json` (the CLI's `init`, or the manual form if the CLI does not recognise brust as a framework: style, `tailwind.css` path, aliases); Tailwind v4 through brust's own plugin (`app.css`, no separate Tailwind build); the `cn` helper (`clsx` + `tailwind-merge`); the `@/*` alias in `tsconfig.json` (works natively once icon-shapes R34.76 is on main; until then, relative imports, stated plainly); `shadcn add button card dialog`; using them in a route; `brust dev` and `brust build`; what stays a React island and why (link to `/docs/shadcn`); dark mode with the CSS variables shadcn generates.
- **R38.3 Where it lives.** A docs page `website/pages/docs/guides/ShadcnSetup.tsx` (slug `guides/shadcn-setup`, linked from `/docs/shadcn` and from Installation), plus a short `docs/shadcn.md` section pointing to it. Code blocks are real files from the verified scratch app (same `CodeBlock` convention as other pages). Every claim has a source comment.
- **R38.4 Test.** A website test that the page renders and links resolve; optionally a CI smoke that runs the guide's commands against the workspace packages (not the network CLI) if it stays under a minute.
- **R38.5 Release.** Ships in the next alpha's release notes ("Guide: set up shadcn/ui").

Gates: website typecheck + tests + `build:static`; the R38.1 transcript reviewed by Afrojack.

**Amendment 2026-10-14 (human order: "React & libraries ทำ"):** this lane also adds a docs nav group **"React & libraries"** right after "Guide", in this order: React coverage (`react-coverage`), Icons and packages (`packages`), shadcn/ui and libraries (`shadcn`), Set up shadcn/ui (`guides/shadcn-setup`). The three existing pages move out of "Guide"; **their slugs do not change** (shared links, search results and the sitemap keep working); only the nav position and the pager order change. Rendering tiers stays in "Guide" (it is a core concept). Website tests that assert the nav order are updated, and a test pins that every old slug still resolves. The guide's `@/` imports are written as the CLI generates them (confirmed by the lead from the verification transcript).
