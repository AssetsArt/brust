import { expect, test } from 'bun:test'
import { DEFAULT_TEMPLATE, listTemplates, selectTemplate } from '../src/templates.ts'

test('listTemplates returns blank + pokedex', () => expect(listTemplates().map((t) => t.name)).toEqual(['blank', 'pokedex']))
test('DEFAULT_TEMPLATE resolves to a registered template (blank)', () => {
  expect(DEFAULT_TEMPLATE).toBe('blank')
  expect(listTemplates().some((t) => t.name === DEFAULT_TEMPLATE)).toBe(true)
})
test('selectTemplate: explicit valid name', () => expect(selectTemplate({ explicit: 'pokedex', yes: false, isTTY: false }).name).toBe('pokedex'))
test('selectTemplate: explicit invalid name throws', () => {
  expect(() => selectTemplate({ explicit: 'x', yes: false, isTTY: false })).toThrow('unknown template "x" — choose one of: blank, pokedex')
})
test('selectTemplate: yes → default blank', () => expect(selectTemplate({ yes: true, isTTY: true }).name).toBe('blank'))
test('selectTemplate: non-TTY → default blank', () => expect(selectTemplate({ yes: false, isTTY: false }).name).toBe('blank'))
const tty = (answers: (string | null)[]) => { const out: string[] = []; const it = answers[Symbol.iterator](); return { out, opts: { yes: false, isTTY: true, read: () => { const n = it.next(); return n.done ? null : n.value }, print: (s: string) => { out.push(s) } } } }
test('selectTemplate: TTY + read "2" → pokedex', () => expect(selectTemplate(tty(['2']).opts).name).toBe('pokedex'))
test('selectTemplate: TTY + read "" → default blank', () => expect(selectTemplate(tty(['']).opts).name).toBe('blank'))
test('selectTemplate: TTY + read name "pokedex" → pokedex', () => expect(selectTemplate(tty(['pokedex']).opts).name).toBe('pokedex'))
test('selectTemplate: TTY + null reader → default blank (no infinite loop)', () => expect(selectTemplate(tty([]).opts).name).toBe('blank'))
test('selectTemplate: TTY + three invalid answers → default blank', () => {
  const t = tty(['9', 'nope', '0'])
  expect(selectTemplate(t.opts).name).toBe('blank')
  expect(t.out.join('')).toContain('Invalid selection "nope"')
})
