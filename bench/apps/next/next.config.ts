import { join } from 'node:path'
import type { NextConfig } from 'next'

// Production-only comparator (spec §1.3): standalone output, run with `node .next/standalone/bench/apps/next/server.js`.
// `outputFileTracingRoot` = the monorepo root so the trace follows the hoisted node_modules AND ../_shared/data.json;
// the side effect is that server.js lands under .next/standalone/<path from root>/ (lib/apps.ts handles both).
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(import.meta.dirname, '../../..'),
  poweredByHeader: false,
  reactStrictMode: true,
}
export default config
