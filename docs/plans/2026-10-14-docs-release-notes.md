# Docs site: release notes + what alpha.6 changed (L34)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: assigned by the coordinator (first free implementer) · reviewer: Afrojack · gates: Illenium · flow: lane → PR → CI → lead merges + deploys brust.dev · ledger row: F154

## Why

Human order, 2026-10-14: publish versions in increments while the work continues, and update the docs site with each. 2.0.0-alpha.6 is published (tag `v2.0.0-alpha.6`, PRs #200–#205). brust.dev must say what it changed, and keep doing so for every later release.

## Requirements

- **R36.1 Release notes page.** `website/pages/docs/ReleaseNotes.tsx`, nav slug `release-notes` (first group, after Installation). One section per version, newest first, starting with 2.0.0-alpha.6; each entry is a user-facing sentence (what you can now write, what got smaller) with a source comment naming the PR. Earlier versions get one line each (alpha.1–alpha.5) from the tags and the ledger, no invention. Adding a release later is one new section.
- **R36.2 shadcn/ui and React libraries page.** Slug `shadcn`, group "Guides" or next to "Icons and packages": what compiles today (rest props and JSX spread, handlers through a spread, `asChild`/Slot at the call site, constant children into islands, `<Pkg.Member>` tags), what stays a React island and why (Radix internals, context, render props), and how to read the scoreboard. **Numbers are never hand-written**: the shadcn generator also writes `docs/shadcn-coverage.json` (summary table + per-row tier/islands/KB, deterministic, committed, checked by the existing `--check`), and the page imports it, as ReactCoverage imports `docs/react-coverage.json`.
- **R36.3 Pages whose behaviour changed.** Rendering tiers: a page loads only the runtime features it uses (core + feature modules, modulepreload in the head; L33). Icons and packages: `<Pkg.Member>` resolves to the package export; constant children travel as JSON (already partly done in #203). React coverage regenerates by itself.
- **R36.4 Every claim has a source comment** (file:line or PR), the convention every docs page already follows.

Gates: website typecheck + tests + `build:static`; `bun scripts/shadcn/run.ts --check` + `bun test scripts/shadcn` (the generator change); the lead deploys brust.dev after merge.
