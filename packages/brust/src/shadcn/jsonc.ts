// A minimal JSONC reader that keeps byte offsets, so a file can be edited with a text splice (comments, trailing
// commas and formatting survive). It does not build values; it finds object members. Anything it cannot read throws.

export interface Member {
  key: string
  /** Offset of the member's key (its opening quote). */
  keyStart: number
  /** Offset of the member's value (the `{` of an object value). */
  value: number
  /** Offset just past the value. */
  end: number
  /** Parsed object when the value is an object, else `undefined`. */
  object?: ObjectNode
}

export interface ObjectNode {
  /** Offset of `{`. */
  open: number
  /** Offset of `}`. */
  close: number
  members: Member[]
}

class Reader {
  i = 0
  constructor(readonly s: string) {}

  ws(): void {
    const { s } = this
    for (;;) {
      const c = s[this.i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') this.i++
      else if (c === '/' && s[this.i + 1] === '/') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++
      } else if (c === '/' && s[this.i + 1] === '*') {
        const e = s.indexOf('*/', this.i + 2)
        if (e < 0) throw new Error('unterminated comment')
        this.i = e + 2
      } else return
    }
  }

  string(): string {
    const { s } = this
    if (s[this.i] !== '"') throw new Error(`expected a string at ${this.i}`)
    let j = this.i + 1
    let out = ''
    while (j < s.length && s[j] !== '"') {
      if (s[j] === '\\') {
        out += s[j + 1] ?? ''
        j += 2
      } else if (s[j] === '\n') throw new Error('newline in a string')
      else out += s[j++]
    }
    if (s[j] !== '"') throw new Error('unterminated string')
    this.i = j + 1
    return out
  }

  /** Skips one value; returns its object node when it is an object. */
  value(): ObjectNode | undefined {
    this.ws()
    const c = this.s[this.i]
    if (c === '{') return this.object()
    if (c === '[') {
      this.i++
      for (;;) {
        this.ws()
        if (this.s[this.i] === ']') {
          this.i++
          return undefined
        }
        this.value()
        this.ws()
        if (this.s[this.i] === ',') this.i++
        else if (this.s[this.i] !== ']') throw new Error(`expected , or ] at ${this.i}`)
      }
    }
    if (c === '"') {
      this.string()
      return undefined
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.s.slice(this.i, this.i + 40))
    if (!m) throw new Error(`unexpected character at ${this.i}`)
    this.i += m[0].length
    return undefined
  }

  object(): ObjectNode {
    const open = this.i
    this.i++
    const members: Member[] = []
    for (;;) {
      this.ws()
      if (this.s[this.i] === '}') {
        this.i++
        return { open, close: this.i - 1, members }
      }
      const keyStart = this.i
      const key = this.string()
      this.ws()
      if (this.s[this.i] !== ':') throw new Error(`expected : at ${this.i}`)
      this.i++
      this.ws()
      const value = this.i
      const object = this.value()
      members.push({ key, keyStart, value, end: this.i, ...(object && { object }) })
      this.ws()
      if (this.s[this.i] === ',') this.i++
      else if (this.s[this.i] !== '}') throw new Error(`expected , or } at ${this.i}`)
    }
  }
}

/** The top-level object of a JSONC text. Throws on anything that is not JSONC. */
export function readObject(text: string): ObjectNode {
  const r = new Reader(text)
  r.ws()
  if (text[r.i] !== '{') throw new Error('not an object')
  const o = r.object()
  r.ws()
  if (r.i !== text.length) throw new Error('trailing content')
  return o
}

/** The raw text of a member's value. */
export function raw(text: string, m: Member): string {
  return text.slice(m.value, m.end)
}
