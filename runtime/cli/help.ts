// Dep-free CLI help/version rendering + a tiny ANSI color util. All functions
// return strings (no console writes) so they're unit-testable. index.ts owns
// the actual stdout/stderr + exit codes.
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Read the brustjs package.json version. `help.ts` lives at
 * <root>/runtime/cli/, so ../../package.json is <root>/package.json in both the
 * source tree and an installed node_modules/brustjs layout. Never throws —
 * returns "unknown" on any failure (version must not crash the CLI). */
export function readVersion(): string {
  try {
    const p = path.join(import.meta.dir, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}
function wrap(open: string, s: string): string {
  return useColor() ? `\x1b[${open}m${s}\x1b[0m` : s
}
export const style = {
  bold: (s: string) => wrap('1', s),
  dim: (s: string) => wrap('2', s),
  cyan: (s: string) => wrap('36', s),
  green: (s: string) => wrap('32', s),
  red: (s: string) => wrap('31', s),
}

interface CommandDef {
  name: string
  summary: string
  usage: string
  flags: { flag: string; desc: string }[]
  /** Free-form lines rendered after the Options block (one paragraph per entry). */
  notes?: string[]
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'build',
    summary: 'Compile a brust app to a self-contained dist/',
    usage: 'brust build [entry] [options]',
    flags: [
      { flag: '[entry]', desc: 'Entry file (default ./index.ts)' },
      { flag: '--out-dir <dir>', desc: 'Output directory (default ./dist)' },
      {
        flag: '--target <t>',
        desc: 'Native target(s): auto | all | <platform>-<arch>[-<libc>][,…] (default auto)',
      },
      {
        flag: '--ssg',
        desc: 'Prerender static routes to HTML files after the build',
      },
      {
        flag: '--ssg-out <dir>',
        desc: 'Output directory for prerendered HTML (default <out-dir>/static)',
      },
    ],
    notes: [
      'Markdown pages: routes mounted with mdRoutes(<contentDir>) compile to native',
      'jinja templates at build time and freeze into <out-dir>/md-manifest.json, so',
      'the dist serves them without the markdown content directory present.',
    ],
  },
  {
    name: 'dev',
    summary: 'Run the dev server with hot reload',
    usage: 'brust dev [entry] [options]',
    flags: [
      { flag: '[entry]', desc: 'Entry file (default ./index.ts)' },
      { flag: '--port <n>', desc: 'Port to listen on' },
    ],
  },
  {
    name: 'new',
    summary: 'Scaffold a new brust project',
    usage: 'brust new <name> [--dir <path>] [--template <name>] [--yes]',
    flags: [
      { flag: '<name>', desc: 'Project name (lowercase letters, digits, - _)' },
      { flag: '--dir <path>', desc: 'Target directory (default ./<name>)' },
      {
        flag: '--template, -t <name>',
        desc: 'Template to scaffold (minimal | pokedex). Prompts if omitted on a TTY; defaults to minimal otherwise.',
      },
      { flag: '--yes, -y', desc: 'Skip the prompt; use the default template (minimal).' },
    ],
  },
]

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length))
}

export function renderVersion(): string {
  return `brustjs ${readVersion()}`
}

export function renderRootHelp(): string {
  const lines: string[] = []
  lines.push(`${style.bold('brust')} ${style.dim(readVersion())} — the brust framework CLI`)
  lines.push('')
  lines.push(`${style.bold('Usage:')} brust <command> [options]`)
  lines.push('')
  const globals = [
    { label: '-h, --help', desc: 'Show help (brust help <command> for details)' },
    { label: '-v, --version', desc: 'Show the brustjs version' },
  ]
  // One shared column width across commands AND global flags so every
  // description lines up in a single column.
  const w = Math.max(...COMMANDS.map((c) => c.name.length), ...globals.map((g) => g.label.length))
  lines.push(style.bold('Commands:'))
  for (const c of COMMANDS) {
    lines.push(`  ${style.cyan(pad(c.name, w))}  ${c.summary}`)
  }
  lines.push('')
  lines.push(style.bold('Global:'))
  for (const g of globals) {
    lines.push(`  ${style.cyan(pad(g.label, w))}  ${g.desc}`)
  }
  lines.push('')
  lines.push(style.dim('Run `brust help <command>` for command-specific options.'))
  return lines.join('\n')
}

export function renderCommandHelp(name: string): string | null {
  const c = COMMANDS.find((x) => x.name === name)
  if (!c) return null
  const lines: string[] = []
  lines.push(`${style.bold('Usage:')} ${c.usage}`)
  lines.push('')
  lines.push(c.summary)
  lines.push('')
  lines.push(style.bold('Options:'))
  const w = Math.max(...c.flags.map((f) => f.flag.length))
  for (const f of c.flags) {
    lines.push(`  ${style.cyan(pad(f.flag, w))}  ${f.desc}`)
  }
  if (c.notes && c.notes.length > 0) {
    lines.push('')
    for (const n of c.notes) lines.push(style.dim(n))
  }
  return lines.join('\n')
}
