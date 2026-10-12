import { describe, expect, test } from 'bun:test'
import { probe, PROBES, serves } from './probes'

describe('probes', () => {
  test('ids in run order', () => {
    expect(PROBES.map((p) => p.id)).toEqual(['S', 'D', 'I', 'A1', 'A2'])
  })
  test('A2 is a JSON POST served by brust and elysia-bun only', () => {
    expect(probe('A2')).toMatchObject({ kind: 'json', method: 'POST', path: '/_brust/action/team', body: '{"id":25}', apps: ['brust', 'elysia-bun'] })
    expect(probe('A2').what).toBeString()
  })
  test('A1 is a JSON GET', () => {
    expect(probe('A1')).toMatchObject({ kind: 'json', method: 'GET', path: '/_brust/action/types', apps: ['brust', 'elysia-bun'] })
  })
  test('page probes are GET pages for the four page apps', () => {
    for (const id of ['S', 'D', 'I'] as const) expect(probe(id)).toMatchObject({ kind: 'page', method: 'GET', apps: ['brust', 'bun-serve', 'next', 'brust-01x'] })
  })
  test('serves()', () => {
    expect(serves('elysia-bun', 'A1')).toBe(true)
    expect(serves('elysia-bun', 'S')).toBe(false)
    expect(serves('bun-serve', 'A2')).toBe(false)
    expect(serves('brust', 'D')).toBe(true)
  })
})
