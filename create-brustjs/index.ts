#!/usr/bin/env bun
// `bun create brustjs <dir>` → Bun runs this bin with the dest dir (and any
// flags) as argv. We forward them straight to brust's own scaffolder, so the
// templates and the brustjs-version pinning stay owned by the brustjs package.
import { runNew } from 'brustjs/create'

await runNew(process.argv.slice(2))
