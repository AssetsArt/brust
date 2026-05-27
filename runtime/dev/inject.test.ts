import { describe, test, expect, beforeEach } from 'bun:test'
import { configureDevClientSnippet, getDevClientSnippet } from './inject.ts'

describe('runtime/dev/inject', () => {
  beforeEach(() => {
    configureDevClientSnippet(null)
  })

  test('starts null', () => {
    expect(getDevClientSnippet()).toBeNull()
  })

  test('configureDevClientSnippet stores a value', () => {
    configureDevClientSnippet('<script>hi</script>')
    expect(getDevClientSnippet()).toBe('<script>hi</script>')
  })

  test('configureDevClientSnippet(null) clears the value', () => {
    configureDevClientSnippet('<script>hi</script>')
    configureDevClientSnippet(null)
    expect(getDevClientSnippet()).toBeNull()
  })

  test('replacing with a new value overwrites', () => {
    configureDevClientSnippet('<script>a</script>')
    configureDevClientSnippet('<script>b</script>')
    expect(getDevClientSnippet()).toBe('<script>b</script>')
  })
})
