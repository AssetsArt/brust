import { describe, test, expect } from 'bun:test'
import { cssLoaderPlugin } from './component-loader.ts'
import type { ComponentCssManifest } from './manifest.ts'

describe('cssLoaderPlugin', () => {
  const manifest: ComponentCssManifest = {
    version: 1,
    modules: {
      '/abs/Button.module.css': {
        chunk: '/_brust/css/components/abc.css',
        exports: { primary: 'primary_abc', secondary: 'secondary_abc' },
      },
      '/abs/foo.css': {
        chunk: '/_brust/css/components/def.css',
        exports: null,
      },
    },
    routeChunks: {},
  }

  test('returns exports JS for known .module.css', async () => {
    const plugin = cssLoaderPlugin(manifest)
    const captured: any[] = []
    const fakeBuild = {
      onLoad(filter: any, fn: any) {
        captured.push({ filter, fn })
      },
    }
    plugin.setup(fakeBuild as any)
    const moduleLoader = captured.find((c) => c.filter.filter.source === '\\.module\\.css$').fn
    const out = await moduleLoader({ path: '/abs/Button.module.css' })
    expect(out.loader).toBe('js')
    expect(out.contents).toBe(
      'export default {"primary":"primary_abc","secondary":"secondary_abc"}',
    )
  })

  test('returns empty exports JS for unknown .module.css', async () => {
    const plugin = cssLoaderPlugin(manifest)
    const captured: any[] = []
    plugin.setup({
      onLoad(f: any, fn: any) {
        captured.push({ filter: f, fn })
      },
    } as any)
    const moduleLoader = captured.find((c) => c.filter.filter.source === '\\.module\\.css$').fn
    const out = await moduleLoader({ path: '/unknown/path.module.css' })
    expect(out.contents).toBe('export default {}')
  })

  test('returns empty JS for plain .css side-effect import', async () => {
    const plugin = cssLoaderPlugin(manifest)
    const captured: any[] = []
    plugin.setup({
      onLoad(f: any, fn: any) {
        captured.push({ filter: f, fn })
      },
    } as any)
    // The plain .css handler is registered second (after .module.css)
    const plainLoader = captured.find(
      (c) => c.filter.filter.source === '\\.css$' && !c.filter.filter.source.includes('module'),
    ).fn
    const out = await plainLoader({ path: '/abs/foo.css' })
    expect(out.loader).toBe('js')
    expect(out.contents).toBe('')
  })
})
