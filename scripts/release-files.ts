// scripts/release-files.ts — the nine version refs shared by release-bump.ts and release-check.ts. Plain module: no side effects.
export const PLATS = ['darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl']
export const FILES = ['packages/brust/package.json', 'packages/runtime-dom/package.json', 'packages/create-app/package.json', ...PLATS.map((p) => `npm/${p}/package.json`)]
