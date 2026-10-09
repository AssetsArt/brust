import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

test('theme-toggle: first paint is stable and a click flips the label and the effect', async () => {
  const m = await load(build('theme-toggle'))
  expect(m.warnings).toEqual([])
  expect(m.after).toBe(m.before)                       // Review Focus 3: mount changes nothing visible
  const b = $('button')
  expect(b.textContent).toBe('Light')
  expect(b.getAttribute('aria-label')).toBe('Toggle theme')
  b.click()
  expect(b.textContent).toBe('Dark')
  expect(document.documentElement.dataset.mode).toBe('light')
  b.click()
  expect(b.textContent).toBe('Light')
  expect(document.documentElement.dataset.mode).toBe('dark')
  expect(m.warnings).toEqual([])                                    // the interactions raised nothing either
})
