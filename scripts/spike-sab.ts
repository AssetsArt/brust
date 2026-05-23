// Spike: does Rust read/write a JS SharedArrayBuffer (via Uint8Array view)
// on Bun + napi-rs 3.x? Tests in main isolate, no Worker thread, no render path.
//
// Run from repo root: bun run scripts/spike-sab.ts

import * as native from '../runtime/index.js'

const sabWriteTest = (native as any).sabWriteTest as (buf: Uint8Array, msg: string) => number

function fail(why: string): never {
  console.error(`✗ ${why}`)
  process.exit(1)
}

// --- Case 1: regular ArrayBuffer (sanity) ---
{
  const ab = new ArrayBuffer(64)
  const view = new Uint8Array(ab)
  const msg = 'hello from regular ArrayBuffer'
  const n = sabWriteTest(view, msg)
  const got = new TextDecoder().decode(view.subarray(0, n))
  if (n !== msg.length) fail(`AB: wrote ${n} expected ${msg.length}`)
  if (got !== msg) fail(`AB: got "${got}" expected "${msg}"`)
  console.log(`✓ ArrayBuffer: ${n} bytes round-tripped`)
}

// --- Case 2: SharedArrayBuffer (the real test) ---
{
  const sab = new SharedArrayBuffer(64)
  const view = new Uint8Array(sab)
  const msg = 'hello via SharedArrayBuffer 💾'  // emoji = multi-byte UTF-8
  const n = sabWriteTest(view, msg)
  const got = new TextDecoder().decode(view.subarray(0, n))
  const expectedBytes = new TextEncoder().encode(msg).length
  if (n !== expectedBytes) fail(`SAB: wrote ${n} expected ${expectedBytes}`)
  if (got !== msg) fail(`SAB: got "${got}" expected "${msg}"`)
  console.log(`✓ SharedArrayBuffer: ${n} bytes round-tripped (incl. multi-byte UTF-8)`)
}

// --- Case 3: truncation when msg > buf ---
{
  const sab = new SharedArrayBuffer(8)
  const view = new Uint8Array(sab)
  const msg = 'this is way too long for an 8-byte buffer'
  const n = sabWriteTest(view, msg)
  if (n !== 8) fail(`truncation: wrote ${n} expected 8`)
  const got = new TextDecoder().decode(view.subarray(0, n))
  if (got !== msg.slice(0, 8)) fail(`truncation: got "${got}" expected "${msg.slice(0, 8)}"`)
  console.log(`✓ Truncation: wrote ${n}/${msg.length} bytes correctly`)
}

console.log('\nAll 3 spike cases passed. SharedArrayBuffer ↔ Rust round-trip works on Bun + napi-rs 3.x.')
