import { expect, test } from 'bun:test'
import { $, build, load } from '../harness.ts'

// G8 (gaps L8): static fragment roots lose their wrapper; an interactive one keeps <brust-host> and must still mount.
test('fragment-root-counter: the interactive fragment root keeps its host and still mounts', async () => {
  const b = build('fragment-root-counter')
  expect(b.html).toContain('<brust-host')
  const m = await load(b)
  expect(m.warnings).toEqual([])
  expect($('[data-testid="n"]').textContent).toBe('0')
  $('button').click()
  expect($('[data-testid="n"]').textContent).toBe('1')
  expect(m.warnings).toEqual([])
})
