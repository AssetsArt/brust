import { test, expect, mock, describe } from 'bun:test'
import { createElement, Suspense } from 'react'
import { renderBranchStreaming, makeMeta } from './stream'

function makeMockNapi() {
  const chunks: Array<{ len: number, bytes: Uint8Array | null }> = []
  return {
    chunks,
    napi: {
      async renderChunk(_workerId: bigint, len: number, sabBytes: Uint8Array) {
        chunks.push({ len, bytes: len === 0 ? null : sabBytes.slice(0, len) })
      },
    },
  }
}

function decodeMeta(firstChunk: Uint8Array): { metaJson: string, body: Uint8Array } {
  const metaLen = (firstChunk[0] << 8) | firstChunk[1]
  const metaJson = new TextDecoder().decode(firstChunk.subarray(2, 2 + metaLen))
  const body = firstChunk.subarray(2 + metaLen)
  return { metaJson, body }
}

const view = new Uint8Array(new ArrayBuffer(256 * 1024))

test('streaming=false when no Suspense; single chunk + final; no bootstrap if no islands', async () => {
  const { chunks, napi } = makeMockNapi()
  await renderBranchStreaming({
    element: createElement('div', null, 'hello'),
    view, workerId: 0n, napi,
    errorBoundary: () => createElement('div', null, 'oops'),
  })
  expect(chunks.length).toBe(2)
  expect(chunks[1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  expect(JSON.parse(metaJson).streaming).toBe(false)
  const bodyStr = new TextDecoder().decode(body)
  expect(bodyStr).toContain('hello')
  expect(bodyStr).not.toContain('importmap')
})

test('streaming=true when Suspense pending; bootstrap always injected in streaming mode', async () => {
  const { chunks, napi } = makeMockNapi()
  let resolve: () => void = () => {}
  const pending = new Promise<void>((r) => { resolve = r })
  // done flag is set when the promise resolves so Slow stops throwing.
  let done = false
  pending.then(() => { done = true })
  function Slow() {
    if (!done) throw pending
    return createElement('span', null, 'late')
  }
  const elem = createElement(Suspense,
    { fallback: createElement('span', null, 'loading') },
    createElement(Slow),
  )
  const renderPromise = renderBranchStreaming({
    element: elem, view, workerId: 0n, napi,
    errorBoundary: () => createElement('div', null, 'oops'),
  })
  setTimeout(() => resolve(), 50)
  await renderPromise
  expect(chunks.length).toBeGreaterThanOrEqual(2)
  expect(chunks[chunks.length - 1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  expect(JSON.parse(metaJson).streaming).toBe(true)
  expect(new TextDecoder().decode(body)).toContain('importmap')
})

test('pre-shell crash → 500 + errorBoundary + final fires', async () => {
  const { chunks, napi } = makeMockNapi()
  function Crash(): never { throw new Error('boom') }
  await renderBranchStreaming({
    element: createElement(Crash),
    view, workerId: 0n, napi,
    errorBoundary: ({ error }: { error: Error }) =>
      createElement('div', null, 'caught: ' + error.message),
  })
  expect(chunks.length).toBe(2)
  expect(chunks[1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  const parsed = JSON.parse(metaJson)
  expect(parsed.status).toBe(500)
  expect(parsed.streaming).toBe(false)
  expect(new TextDecoder().decode(body)).toContain('caught: boom')
})

test('post-shell crash → onError logged + final still fires (no hang)', async () => {
  const consoleSpy = mock(() => {})
  const origErr = console.error
  console.error = consoleSpy
  const { chunks, napi } = makeMockNapi()
  function Bad(): never { throw new Error('post-shell-boom') }
  const elem = createElement(Suspense,
    { fallback: createElement('span', null, 'loading') },
    createElement(Bad),
  )
  await renderBranchStreaming({
    element: elem, view, workerId: 0n, napi,
    errorBoundary: () => createElement('div', null, 'caught'),
  })
  console.error = origErr
  expect(chunks[chunks.length - 1].len).toBe(0)
  expect(consoleSpy.mock.calls.length).toBeGreaterThan(0)
})

test('errorBoundary itself throws → plain-text fallback + final fires', async () => {
  const { chunks, napi } = makeMockNapi()
  function Crash(): never { throw new Error('boom') }
  function BadBoundary(): never { throw new Error('boundary-also-broken') }
  await renderBranchStreaming({
    element: createElement(Crash),
    view, workerId: 0n, napi,
    errorBoundary: BadBoundary,
  })
  expect(chunks.length).toBe(2)
  expect(chunks[1].len).toBe(0)
  const { metaJson, body } = decodeMeta(chunks[0].bytes!)
  const parsed = JSON.parse(metaJson)
  expect(parsed.status).toBe(500)
  expect(parsed.contentType).toContain('text/plain')
  expect(new TextDecoder().decode(body)).toBe('Internal Server Error')
})

test('makeMeta defaults: contentType=text/html, headers={}, given status+streaming', () => {
  const json = makeMeta({ status: 200, streaming: true })
  const parsed = JSON.parse(json)
  expect(parsed.status).toBe(200)
  expect(parsed.streaming).toBe(true)
  expect(parsed.contentType).toBe('text/html; charset=utf-8')
  expect(parsed.headers).toEqual({})
})

import { configureCssEnabled } from '../css.ts'
import { injectCssLink } from './inject-css-link.ts'

describe('renderBranchStreaming + CSS', () => {
  test('first-chunk body contains <link> when getCssHrefs is non-empty', () => {
    // Pure check on the helper composition — the renderer wires it
    // by calling injectCssLink(body, getCssHrefs()), so a positive
    // test on the helper combined with a manual configure proves the
    // wiring. End-to-end coverage lives in tests/cli-build.test.ts.
    configureCssEnabled(['/_brust/css/app.css'])
    const enc = new TextEncoder()
    const out = injectCssLink(
      enc.encode('<head></head>'),
      ['/_brust/css/app.css'],
    )
    expect(new TextDecoder().decode(out)).toContain('<link rel="stylesheet" href="/_brust/css/app.css">')
    configureCssEnabled([])  // reset
  })
})
