import { resolve } from 'node:path'
import type { BunPlugin } from 'bun'

/** Bun.build plugin that replaces `runtime/index.js` (the napi-rs platform
 * shim, 469 lines of conditional require()s) with a single shim that resolves
 * the native binary from `BRUST_DIST_DIR/native/brust.<platform>-<arch>.node`.
 *
 * The shim relies on the bundle banner having set BRUST_DIST_DIR; if that env
 * is missing (shouldn't happen post-build) it falls back to import.meta.dir.
 *
 * KNOWN LIMITATION: this resolves `brust.<platform>-<arch>.node` with no libc
 * segment, so it matches darwin (brust.darwin-arm64.node) but NOT Linux, where
 * napi emits a libc-suffixed name (brust.linux-x64-gnu.node / -musl). `brust
 * build` dist bundles therefore don't load on Linux yet — pre-existing; the
 * npm-package path uses the full napi loader (with libc detection) instead. */
export function nativeShimPlugin(repoRoot: string): BunPlugin {
  const targetPath = resolve(repoRoot, 'runtime/index.js')

  const SHIM = `
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require_ = createRequire(import.meta.url)
const { platform, arch } = process
const binaryName = \`brust.\${platform}-\${arch}.node\`
const dir = process.env.BRUST_DIST_DIR ?? import.meta.dir
const absPath = join(dir, 'native', binaryName)

let nativeBinding
try {
  nativeBinding = require_(absPath)
} catch (cause) {
  throw new Error(
    \`brust: no native binary for \${platform}-\${arch} at \${absPath}. \` +
    \`Run \\\`brust build\\\` on the target platform.\`,
    { cause },
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
