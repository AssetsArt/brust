#!/usr/bin/env bun
const [, , subcommand, ...rest] = process.argv

switch (subcommand) {
  case 'build': {
    const { runBuild } = await import('./build.ts')
    await runBuild(rest)
    break
  }
  default: {
    if (!subcommand) {
      console.error('brust: missing subcommand. Try: brust build')
    } else {
      console.error(`brust: unknown subcommand "${subcommand}". Try: brust build`)
    }
    process.exit(1)
  }
}
