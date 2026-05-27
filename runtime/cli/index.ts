#!/usr/bin/env bun
const [, , subcommand, ...rest] = process.argv

switch (subcommand) {
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
  default: {
    if (!subcommand) {
      console.error('brust: missing subcommand. Try: brust build | brust dev')
    } else {
      console.error(`brust: unknown subcommand "${subcommand}". Try: brust build | brust dev`)
    }
    process.exit(1)
  }
}
