import { describe, expect, test } from 'bun:test'
import { injectAiClient } from './inject-ai-client.ts'
import { aiScriptTag } from '../generator.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const body = (s: string) => enc.encode(s)
const str = (b: Uint8Array) => dec.decode(b)

describe('injectAiClient', () => {
  test('splices the AI script immediately before </head>', () => {
    const out = injectAiClient(body('<head><title>x</title></head><body></body>'), aiScriptTag())
    expect(str(out)).toBe(
      `<head><title>x</title>${aiScriptTag()}</head><body></body>`,
    )
  })

  test('returns the original body when </head> is absent', () => {
    const src = body('<div>fragment</div>')
    const out = injectAiClient(src, aiScriptTag())
    expect(out).toBe(src)
  })

  test('returns the original body when snippet is empty', () => {
    const src = body('<head></head>')
    const out = injectAiClient(src, '')
    expect(out).toBe(src)
  })
})
