import { describe, test, expect, beforeEach } from 'bun:test'
import { configureCssEnabled, getCssHrefs } from './css.ts'

describe('runtime/css', () => {
  beforeEach(() => {
    // Reset module state between tests by calling with empty.
    configureCssEnabled([])
  })

  test('starts empty', () => {
    expect(getCssHrefs()).toEqual([])
  })

  test('configureCssEnabled stores hrefs', () => {
    configureCssEnabled(['/_brust/css/app.css'])
    expect(getCssHrefs()).toEqual(['/_brust/css/app.css'])
  })

  test('multiple calls replace the previous list', () => {
    configureCssEnabled(['/a.css'])
    configureCssEnabled(['/b.css', '/c.css'])
    expect(getCssHrefs()).toEqual(['/b.css', '/c.css'])
  })

  test('getCssHrefs returns a defensive copy', () => {
    configureCssEnabled(['/a.css'])
    const out = getCssHrefs() as string[]
    out.push('/mutated.css')
    expect(getCssHrefs()).toEqual(['/a.css'])
  })

  test('configureCssEnabled stores a defensive copy of its argument', () => {
    const input = ['/a.css']
    configureCssEnabled(input)
    input.push('/mutated.css')
    expect(getCssHrefs()).toEqual(['/a.css'])
  })
})
