# shadcn survey (S0)

`bun run shadcn` writes `docs/shadcn-coverage.md`; `bun run shadcn -- --check` fails on a stale doc; `bun test scripts/shadcn` asserts the same plus determinism. Needs the napi addon (`cd packages/brust && bun run build:debug`).

## Refreshing the fixture (a deliberate PR)

1. In a scratch copy of `tests/fixtures/shadcn/{package.json,components.json,tsconfig.json,app.css}` (without `@brust/core`): `bunx shadcn@<version> add $(jq -r .items shadcn.lock.json) -y -o`.
2. Copy `components/` and `hooks/` back over the fixture; take the new dependency list into the fixture `package.json`; `bun install`.
3. Rewrite the sibling imports to relative ones (`from "@/components/ui/x"` → `from "./x"`, `"@/hooks/y"` → `"../../hooks/y"`): the compiler reads the `@/` alias as a package (see row `button-alias`).
4. Add a page for every new component; keep `routes.tsx` listing every page; update `shadcn.lock.json`.
5. `bun run shadcn`, commit the regenerated doc.
