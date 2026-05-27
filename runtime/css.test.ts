import { describe, test, expect, beforeEach } from 'bun:test'
import { configureCssEnabled, getCssHrefs, configureCssHrefsForRoute, getCssHrefsForRoute, _resetCssForTests } from './css.ts'

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

describe('runtime/css route-keyed', () => {
  test('per-route hrefs default to []', () => {
    _resetCssForTests()
    expect(getCssHrefsForRoute('/')).toEqual([])
  })

  test('configureCssHrefsForRoute stores + getCssHrefsForRoute reads', () => {
    _resetCssForTests()
    configureCssHrefsForRoute('/', ['/a.css', '/b.css'])
    expect(getCssHrefsForRoute('/')).toEqual(['/a.css', '/b.css'])
    expect(getCssHrefsForRoute('/other')).toEqual([])
  })

  test('per-route hrefs are independent of global', () => {
    _resetCssForTests()
    configureCssEnabled(['/global.css'])
    configureCssHrefsForRoute('/', ['/route.css'])
    expect(getCssHrefs()).toEqual(['/global.css'])
    expect(getCssHrefsForRoute('/')).toEqual(['/route.css'])
  })

  test('getCssHrefsForRoute returns a defensive copy', () => {
    _resetCssForTests()
    configureCssHrefsForRoute('/', ['/a.css'])
    const out = getCssHrefsForRoute('/') as string[]
    out.push('/x.css')
    expect(getCssHrefsForRoute('/')).toEqual(['/a.css'])
  })
})
