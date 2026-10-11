import { expect, test } from 'bun:test'
import { checkBalance } from './balance'

test('an even spread passes; the smallest share is reported', () => {
  const b = checkBalance([100, 98, 105, 97])
  expect(b.ok).toBe(true)
  expect(b.total).toBe(400)
  expect(b.minShare).toBeCloseTo(0.2425, 3)
})
test('one process taking everything (macOS reusePort) fails the 5% rule', () => {
  expect(checkBalance([10000, 0, 0, 0]).ok).toBe(false)
  expect(checkBalance([960, 20, 10, 10]).ok).toBe(false)
})
test('exactly 5% passes; no traffic or no processes fails', () => {
  expect(checkBalance([95, 5]).ok).toBe(true)
  expect(checkBalance([0, 0]).ok).toBe(false)
  expect(checkBalance([]).ok).toBe(false)
})
