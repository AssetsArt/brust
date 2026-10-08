import { readFileSync, statSync } from 'node:fs'
const result = await Bun.build({
  entrypoints: ['./src/index.ts'], outdir: './dist', format: 'esm', target: 'browser', minify: true,
})
if (!result.success) { for (const l of result.logs) console.error(l); process.exit(1) }
const js = readFileSync('./dist/index.js', 'utf8')
if (/from\s*["']react/.test(js) || js.includes('react/jsx-runtime')) { console.error('[build] react leaked into runtime-dom'); process.exit(1) }
console.log(`[build] dist/index.js ${statSync('./dist/index.js').size} bytes`)
