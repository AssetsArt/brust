import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { $, build, load, type } from '../harness.ts'

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

test('custom-hook-debounce: the inlined hook settles the text 300ms after the last keystroke', async () => {
  const m = await load(build('custom-hook-debounce'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)                                    // mount changes nothing visible
  const input = $<HTMLInputElement>('#q')
  expect(input.value).toBe('pika')
  expect($('#shown').textContent).toBe('pika')
  type(input, 'pi')
  jest.advanceTimersByTime(200)
  type(input, 'pic')                                                // restarts the debounce: the effect's cleanup cleared the timer
  jest.advanceTimersByTime(200)
  expect($('#shown').textContent).toBe('pika')
  jest.advanceTimersByTime(100)
  expect($('#shown').textContent).toBe('pic')
  expect(m.warnings).toEqual([])
})
