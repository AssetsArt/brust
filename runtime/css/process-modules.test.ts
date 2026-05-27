import { describe, test, expect } from 'bun:test'
import { processCssFile } from './process-modules.ts'

describe('processCssFile', () => {
  test('non-module .css → passthrough; class names unchanged', async () => {
    const result = await processCssFile({
      filename: '/abs/foo.css',
      source: '.my-class { color: red }\n',
      isModule: false,
      tailwindCompile: null,
    })
    const code = new TextDecoder().decode(result.code)
    expect(code).toContain('.my-class')
    expect(result.exports).toBeNull()
  })

  test('.module.css → class names hashed; exports map populated', async () => {
    const result = await processCssFile({
      filename: '/abs/Button.module.css',
      source: '.primary { color: blue }\n.secondary { color: green }\n',
      isModule: true,
      tailwindCompile: null,
    })
    const code = new TextDecoder().decode(result.code)
    expect(code).toMatch(/\.primary_[A-Za-z0-9]+/)
    expect(code).toMatch(/\.secondary_[A-Za-z0-9]+/)
    expect(result.exports).not.toBeNull()
    expect(result.exports!.primary).toMatch(/^primary_/)
    expect(result.exports!.secondary).toMatch(/^secondary_/)
    // Same file → both classes share the file-derived hash suffix
    const suffix = (k: string) => result.exports![k].split('_')[1]
    expect(suffix('primary')).toBe(suffix('secondary'))
  })

  test('throws with file path on syntax error', async () => {
    await expect(processCssFile({
      filename: '/abs/broken.module.css',
      source: '.x { color }\n',
      isModule: true,
      tailwindCompile: null,
    })).rejects.toThrow()
  })
})
