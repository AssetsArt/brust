import { expect, test } from 'bun:test'
import path from 'node:path'
import { parseArgs } from '../src/args.ts'

test('parseArgs: positional name → targetDir = cwd/<name>', () => {
  const r = parseArgs(['my-app'])
  expect(r.projectName).toBe('my-app')
  expect(r.targetDir).toBe(path.resolve(process.cwd(), 'my-app'))
})
test('parseArgs: --dir overrides target', () => expect(parseArgs(['my-app', '--dir', '/tmp/foo']).targetDir).toBe('/tmp/foo'))
test('parseArgs: --dir=value form', () => expect(parseArgs(['my-app', '--dir=/tmp/bar']).targetDir).toBe('/tmp/bar'))
test('parseArgs: relative --dir resolved against cwd', () => expect(parseArgs(['my-app', '--dir', './subdir']).targetDir).toBe(path.resolve(process.cwd(), 'subdir')))
test('parseArgs: missing name throws', () => expect(() => parseArgs([])).toThrow(/missing project name/))
test('parseArgs: unknown flag throws', () => expect(() => parseArgs(['my-app', '--bogus'])).toThrow(/unknown flag/))
test('parseArgs: --dir without value throws', () => expect(() => parseArgs(['my-app', '--dir'])).toThrow(/--dir requires a value/))
test('parseArgs: invalid project name throws (uppercase)', () => expect(() => parseArgs(['MyApp'])).toThrow(/invalid project name/))
test('parseArgs: invalid project name throws (starts with hyphen)', () => expect(() => parseArgs(['-foo'])).toThrow(/unknown flag/))
test('parseArgs: invalid project name throws (space)', () => expect(() => parseArgs(['foo bar'])).toThrow(/invalid project name/))
test('parseArgs: digit-start name is valid', () => expect(parseArgs(['1-foo']).projectName).toBe('1-foo'))
test('parseArgs: name too long throws', () => expect(() => parseArgs(['a'.repeat(51)])).toThrow(/too long/))
test('parseArgs: --template pokedex', () => expect(parseArgs(['x', '--template', 'pokedex']).template).toBe('pokedex'))
test('parseArgs: --template=pokedex', () => expect(parseArgs(['x', '--template=pokedex']).template).toBe('pokedex'))
test('parseArgs: -t blank', () => expect(parseArgs(['x', '-t', 'blank']).template).toBe('blank'))
test('parseArgs: --template without value throws', () => expect(() => parseArgs(['x', '--template'])).toThrow(/--template requires a value/))
test('parseArgs: --template= (empty) throws', () => expect(() => parseArgs(['x', '--template='])).toThrow(/--template requires a value/))
test('parseArgs: --yes / -y set yes', () => {
  expect(parseArgs(['x', '--yes']).yes).toBe(true)
  expect(parseArgs(['x', '-y']).yes).toBe(true)
})
test('parseArgs: yes defaults false, template undefined', () => {
  const r = parseArgs(['x'])
  expect([r.yes, r.template, r.brustDep, r.tailwind, r.help]).toEqual([false, undefined, undefined, false, false])
})
test('parseArgs: --tailwind is still accepted (L21; a no-op since L28)', () => expect(parseArgs(['x', '--tailwind']).tailwind).toBe(true))
test('parseArgs: --brust-dep <spec> and --brust-dep=<spec> set brustDep; empty throws', () => {
  expect(parseArgs(['x', '--brust-dep', 'file:/a']).brustDep).toBe('file:/a')
  expect(parseArgs(['x', '--brust-dep=file:/b']).brustDep).toBe('file:/b')
  expect(() => parseArgs(['x', '--brust-dep'])).toThrow(/--brust-dep requires a value/)
  expect(() => parseArgs(['x', '--brust-dep='])).toThrow(/--brust-dep requires a value/)
})
test('parseArgs: a bare -- is ignored (bun create passes it through)', () => expect(parseArgs(['x', '--', '--yes']).yes).toBe(true))
test('parseArgs: --help / -h set help and skip name validation', () => {
  expect(parseArgs(['--help']).help).toBe(true)
  expect(parseArgs(['-h']).help).toBe(true)
})
test('parseArgs: --shadcn alone = set up only; --shadcn=a,b lists components; hostile names throw before anything is made (F181)', () => {
  expect(parseArgs(['x']).shadcn).toBeUndefined()
  expect(parseArgs(['x', '--shadcn']).shadcn).toEqual([])
  expect(parseArgs(['x', '--shadcn=button,card,dialog']).shadcn).toEqual(['button', 'card', 'dialog'])
  expect(parseArgs(['x', '--shadcn=https://ui.example.dev/r/a.json,button']).shadcn).toEqual(['https://ui.example.dev/r/a.json', 'button'])
  for (const bad of ['Button', '-y', 'a;rm', 'a b', 'http://x.dev/a.json', '../x']) expect(() => parseArgs(['x', `--shadcn=${bad}`])).toThrow(/--shadcn component/)
})
