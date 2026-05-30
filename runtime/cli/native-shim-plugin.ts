import { resolve } from 'node:path'
import type { BunPlugin } from 'bun'

/** Bun.build plugin that replaces `runtime/index.js` (the napi-rs platform
 * shim, 469 lines of conditional require()s) with a single shim that resolves
 * the native binary from `BRUST_DIST_DIR/native/brust.<platform>-<arch>[-libc].node`.
 *
 * The shim relies on the bundle banner having set BRUST_DIST_DIR; if that env
 * is missing (shouldn't happen post-build) it falls back to import.meta.dir.
 *
 * Linux: napi emits a libc-suffixed name (brust.linux-x64-gnu.node / -musl);
 * darwin/win have no suffix. The shim detects musl-vs-glibc (via process.report,
 * the same signal the full napi loader uses) to order candidates, then falls
 * back to the other libc so a single-platform dist still loads even if detection
 * is off. */
export function nativeShimPlugin(repoRoot: string): BunPlugin {
  const targetPath = resolve(repoRoot, 'runtime/index.js')

  const SHIM = `
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require_ = createRequire(import.meta.url)
const { platform, arch } = process
const dir = process.env.BRUST_DIST_DIR ?? import.meta.dir

// Detect musl via process.report: glibc runtimes report glibcVersionRuntime in
// the report header, musl does not. Mirrors the full napi loader's signal.
function linuxIsMusl() {
  try {
    if (typeof process.report?.getReport === 'function') {
      process.report.excludeNetwork = true
      const report = process.report.getReport()
      return !(report && report.header && report.header.glibcVersionRuntime)
    }
  } catch {}
  return false
}

// Candidate binary names in load order. Linux is libc-suffixed (detected libc
// first, the other as fallback); darwin/win are bare platform-arch.
let candidates
if (platform === 'linux') {
  const libc = linuxIsMusl() ? 'musl' : 'gnu'
  const other = libc === 'musl' ? 'gnu' : 'musl'
  candidates = [\`brust.linux-\${arch}-\${libc}.node\`, \`brust.linux-\${arch}-\${other}.node\`]
} else {
  candidates = [\`brust.\${platform}-\${arch}.node\`]
}

let nativeBinding
const tried = []
for (const name of candidates) {
  const absPath = join(dir, 'native', name)
  try {
    nativeBinding = require_(absPath)
    break
  } catch (cause) {
    tried.push(\`\${absPath} (\${cause && cause.message ? cause.message : cause})\`)
  }
}
if (!nativeBinding) {
  throw new Error(
    \`brust: no native binary for \${platform}-\${arch}. Tried:\\n  \` +
    tried.join('\\n  ') +
    \`\\nRun \\\`brust build\\\` on the target platform.\`,
  )
}

module.exports = nativeBinding
`.trim()

  return {
    name: 'brust-native-shim',
    setup(build) {
      build.onLoad({ filter: /.*runtime[\\/]index\.js$/ }, (args) => {
        // Only rewrite the canonical napi-rs shim; ignore any same-named file
        // elsewhere in node_modules (Bun resolves real paths, so this guard
        // is just belt-and-braces).
        if (args.path !== targetPath) return undefined
        return { contents: SHIM, loader: 'js' }
      })
    },
  }
}
