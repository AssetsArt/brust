// usage: WT=<worktree with a built addon> bun show.ts <app root> <page> [componentIdPrefix]
// Compiles <page> as `brust build` does (compileTree) and prints every component's tier and fallback/info diagnostics;
// with a prefix, also that component's jinja and client chunk.
const wt = process.env.WT ?? '../../..'
const { compileTree } = await import(`${wt}/packages/brust/native/index.js`)
const [root, rel, prefix] = [process.argv[2]!, process.argv[3]!, process.argv[4]]
const tree = compileTree(rel, root, '/_brust/runtime.js', [], null, null, null, [], '[]')
if (tree.error) { console.log('ERROR', JSON.stringify(tree.error)); process.exit(0) }
for (const c of tree.components) {
  const ir = JSON.parse(c.ir)
  const t = typeof ir.tier === 'string' ? ir.tier : `React(${ir.tier.React.reason})`
  console.log(`== ${c.id} ${t}`)
  for (const d of c.diagnostics) if (d.class !== 'warning') console.log(`   [${d.class}] ${d.rule}: ${String(d.message).slice(0, 300)}`)
  if (prefix && c.id.startsWith(prefix)) { console.log(c.jinja); console.log(c.clientJs ?? '(no chunk)') }
}
