import { expect, test } from 'bun:test'
import { evaluateGuards, type GuardInput } from './guard'

const good: GuardInput = { loadavg1: 2.5, cores: 10, ohaOnPath: true, releaseAddonDeclared: true, addonPresent: true, nodeVersion: 'v22.23.1', needNode: true }

test('a quiet host with every tool passes', () => {
  expect(evaluateGuards(good)).toEqual({ ok: true })
})
test('1-min load average above the core count → exit 2 (busy host)', () => {
  const v = evaluateGuards({ ...good, loadavg1: 10.5 })
  expect(v).toMatchObject({ ok: false, code: 2 })
  expect((v as { reason: string }).reason).toMatch(/load average 10.5 > 10 cores/)
})
test('load equal to cores is still allowed', () => {
  expect(evaluateGuards({ ...good, loadavg1: 10 })).toEqual({ ok: true })
})
test('oha missing → exit 1 with the install hint', () => {
  expect(evaluateGuards({ ...good, ohaOnPath: false })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/cargo install oha/) })
})
test('BRUST_RELEASE_ADDON unset or addon absent → exit 1', () => {
  expect(evaluateGuards({ ...good, releaseAddonDeclared: false })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/BRUST_RELEASE_ADDON=1/) })
  expect(evaluateGuards({ ...good, addonPresent: false })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/bun run build/) })
})
test('Node < 22 or missing only matters when next is selected', () => {
  expect(evaluateGuards({ ...good, nodeVersion: 'v20.11.0' })).toMatchObject({ ok: false, code: 1, reason: expect.stringMatching(/Node >= 22/) })
  expect(evaluateGuards({ ...good, nodeVersion: null })).toMatchObject({ ok: false, code: 1 })
  expect(evaluateGuards({ ...good, nodeVersion: null, needNode: false })).toEqual({ ok: true })
})
