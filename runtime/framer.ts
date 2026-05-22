export type Frame =
  | { type: "route_registry"; routes: string[] }
  | { type: "ready" }
  | { type: "render"; route_id: number; url: string }
  | { type: "render_ok"; html: string }
  | { type: "render_err"; message: string }
  | { type: "shutdown" }

const MAX_FRAME = 16 * 1024 * 1024

export function encodeFrame(frame: Frame): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(frame))
  if (body.length > MAX_FRAME) {
    throw new Error(`frame too large: ${body.length} bytes`)
  }
  const out = new Uint8Array(4 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length, true) // little-endian
  out.set(body, 4)
  return out
}

export class Framer {
  private buf: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf, 0)
    merged.set(chunk, this.buf.length)
    this.buf = merged

    const out: Frame[] = []
    while (this.buf.length >= 4) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength)
      const len = view.getUint32(0, true)
      if (len > MAX_FRAME) {
        throw new Error(`frame too large: ${len} bytes`)
      }
      if (this.buf.length < 4 + len) break
      const body = this.buf.subarray(4, 4 + len)
      const text = new TextDecoder().decode(body)
      out.push(JSON.parse(text) as Frame)
      this.buf = this.buf.slice(4 + len)
    }
    return out
  }
}
