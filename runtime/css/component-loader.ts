import type { BunPlugin } from 'bun'
import type { ComponentCssManifest } from './manifest.ts'

/** Build a Bun.plugin that resolves component CSS imports.
 *  - .module.css → `export default <name-map>` (JS, baked from manifest)
 *  - .css        → empty JS (side-effect; real CSS already on disk)
 *
 * Register once per isolate (brust.run main + each worker). */
export function cssLoaderPlugin(manifest: ComponentCssManifest): BunPlugin {
  return {
    name: 'brust-component-css',
    setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, ({ path }) => {
        const mod = manifest.modules[path]
        const exports = mod?.exports ?? {}
        return {
          contents: `export default ${JSON.stringify(exports)}`,
          loader: 'js',
        }
      })
      build.onLoad({ filter: /\.css$/ }, () => ({
        contents: '',
        loader: 'js',
      }))
    },
  }
}
