// `create-app` main — a port of 0.1.x runNew (runtime/cli/new.ts:221-294) with the v2 dependency resolution.
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { copyTemplate } from './copy.ts'
import { parseArgs, USAGE } from './args.ts'
import { applyOverrides, monorepoRoot, resolveBrustDep } from './dep.ts'
import { TAILWIND_DEFAULT_NOTE } from './tailwind.ts'
import { selectTemplate } from './templates.ts'

const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try { parsed = parseArgs(argv) } catch (e) { return fail(msg(e)) }
  if (parsed.help) {
    console.log(USAGE)
    return
  }
  const { projectName, targetDir } = parsed

  const targetExisted = existsSync(targetDir)
  if (targetExisted && (await readdir(targetDir)).length > 0) return fail(`create-app: target directory "${targetDir}" is not empty`)

  let tmpl: ReturnType<typeof selectTemplate>
  try { tmpl = selectTemplate({ explicit: parsed.template, yes: parsed.yes, isTTY: Boolean(process.stdin.isTTY) }) } catch (e) { return fail(msg(e)) }
  // L28 R29.1: Tailwind is the blank template's default; the flag stays accepted so older instructions still work.
  if (parsed.tailwind) console.log(TAILWIND_DEFAULT_NOTE)
  const dep = resolveBrustDep({ explicit: parsed.brustDep, targetDir })

  try {
    // R5: from a brust checkout the generated template is rebuilt first, so a developer never copies a stale one.
    if (tmpl.generated && monorepoRoot() && !process.env.CREATE_APP_TEMPLATES_DIR) {
      const { syncTemplate } = await import('../scripts/sync-template.ts')
      syncTemplate()
    }
    await copyTemplate({
      templateDir: tmpl.dir,
      targetDir,
      substitutions: { __PROJECT_NAME__: projectName, __BRUST_DEP__: JSON.stringify(dep.spec) },
    })
    if (dep.overrides) applyOverrides(targetDir, dep.overrides)
  } catch (e) {
    if (!targetExisted) await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    return fail(`create-app: failed to scaffold (${msg(e)})`)
  }
  printNextSteps(projectName, targetDir, tmpl.name, dep.kind === 'workspace')
}

function printNextSteps(name: string, targetDir: string, template: string, workspace: boolean): void {
  const cwd = process.cwd()
  const displayPath = targetDir.startsWith(`${cwd}/`) ? `./${targetDir.slice(cwd.length + 1)}` : targetDir
  console.log(`Created ${name} at ${targetDir} (template: ${template})\n`)
  console.log('Next:')
  console.log(`  cd ${displayPath}`)
  console.log(workspace ? '  bun install   # run it at the brust repo root: this app is a workspace member' : '  bun install')
  console.log('  bun run dev')
}
