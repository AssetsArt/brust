// usage: BRUST_ADDON=<addon index.js> bun show.ts <root> <page> [idPrefix] -- prints tier/diagnostics, and jinja + client for components whose id starts with prefix
// BRUST_ADDON: path to packages/brust/native/index.js in a worktree with a built addon
const { compileTree } = await import(process.env.BRUST_ADDON ?? '../../../packages/brust/native/index.js')
import { readFileSync, existsSync } from 'node:fs'
const [root, rel, want] = [process.argv[2]!, process.argv[3]!, process.argv[4]]
const pkf = `${root}/.probe-packages.json`
const pk = existsSync(pkf) && process.env.PK ? readFileSync(pkf, 'utf8') : undefined
const tree = pk ? compileTree(rel, root, '/_brust/runtime.js', [], null, null, null, [], '[]', pk) : compileTree(rel, root, '/_brust/runtime.js', [], null, null, null, [], '[]')
if (tree.error) { console.log('ERROR', JSON.stringify(tree.error)); process.exit(0) }
for (const c of tree.components) {
  const ir = JSON.parse(c.ir)
  const t = typeof ir.tier === 'string' ? ir.tier : `React(${ir.tier.React.reason})`
  console.log(`== ${c.id} ${t}`)
  for (const d of c.diagnostics) if (d.class !== 'warning' || process.env.W) console.log(`   [${d.class}] ${d.rule}: ${String(d.message).slice(0, 400)}`)
  if (want && c.id.startsWith(want)) { console.log('--- jinja'); console.log(String(c.jinja)); console.log('--- clientJs'); console.log(String(c.clientJs ?? '')) }
}
