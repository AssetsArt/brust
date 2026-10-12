// scripts/release-files.ts — the eleven version refs shared by release-bump.ts and release-check.ts. Plain module: no side effects.
export const PLATS = ['darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl']
export const CORE_CF = 'npm/core-cf'
export const FILES = ['packages/brust/package.json', 'packages/runtime-dom/package.json', 'packages/create-app/package.json', ...PLATS.map((p) => `npm/${p}/package.json`), `${CORE_CF}/package.json`, 'packages/cache-redis/package.json']
