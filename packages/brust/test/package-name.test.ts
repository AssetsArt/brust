import { expect, test } from 'bun:test'
import pkg from '../package.json'

test('published name and exports agree', () => {
  expect(pkg.name).toBe('@brust/core')
  for (const key of Object.keys(pkg.exports)) expect(() => Bun.resolveSync(`@brust/core${key.slice(1)}`, import.meta.dir)).not.toThrow()
})
