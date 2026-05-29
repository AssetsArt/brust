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
  case 'new': {
    const { runNew } = await import('./new.ts')
    await runNew(rest)
    break
  }
  default: {
    if (!subcommand) {
      console.error('brust: missing subcommand. Try: brust build | brust dev | brust new')
    } else {
      console.error(
        `brust: unknown subcommand "${subcommand}". Try: brust build | brust dev | brust new`,
      )
    }
    process.exit(1)
  }
}
