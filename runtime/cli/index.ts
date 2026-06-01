#!/usr/bin/env bun
import { COMMANDS, renderCommandHelp, renderRootHelp, renderVersion } from './help.ts'

const argv = process.argv.slice(2)
const first = argv[0]
const second = argv[1]

// Derive from COMMANDS so the dispatch set and the help registry can never
// drift (a name in KNOWN but absent from COMMANDS would print `null` as help).
const KNOWN = new Set(COMMANDS.map((c) => c.name))

function hasHelpFlag(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}

if (first === '--version' || first === '-v' || first === 'version') {
  console.log(renderVersion())
  process.exit(0)
}

if (first === '--help' || first === '-h' || first === 'help') {
  if (second && KNOWN.has(second)) {
    console.log(renderCommandHelp(second))
    process.exit(0)
  }
  if (second) {
    console.error(`brust: unknown command "${second}".`)
    console.error(renderRootHelp())
    process.exit(1)
  }
  console.log(renderRootHelp())
  process.exit(0)
}

if (first && KNOWN.has(first)) {
  const rest = argv.slice(1)
  if (hasHelpFlag(rest)) {
    console.log(renderCommandHelp(first))
    process.exit(0)
  }
  switch (first) {
    case 'build': {
      const { runBuild } = await import('./build.ts')
      await runBuild(rest)
      break
    }
    case 'dev': {
      const { runDev } = await import('./dev.ts')
      await runDev(rest)
      break
    }
    case 'new': {
      const { runNew } = await import('./new.ts')
      await runNew(rest)
      break
    }
  }
} else if (!first) {
  console.error(renderRootHelp())
  process.exit(1)
} else {
  console.error(`brust: unknown command "${first}".`)
  console.error('Run `brust --help` to see available commands.')
  process.exit(1)
}
