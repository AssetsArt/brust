#!/usr/bin/env bun
// `bun create @brust/app <name> …` runs this bin (bunx @brust/create-app) with the remaining argv.
import { main } from '../src/cli.ts'
await main(process.argv.slice(2))
