import { navigate as brustNavigate } from '../navigation/navigate.ts'
import { _getNavigator, getNavState, subscribe } from '../navigation/store.ts'
import { struct, type PageStruct } from './struct.ts'
import type { ErrorResult } from './refs.ts'

export interface NavigateOptions {
  struct?: boolean
  timeout?: number
}

export interface NavResult {
  ok: true
  url: string
  status: 'spa' | 'full-load' | 'external'
  struct?: PageStruct
}

function failure(code: 'timeout' | 'nav-failed', message: string, hint?: string): ErrorResult {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

function allIslandsRegistered(): boolean {
  return document.querySelector('[data-brust-island]:not([data-brust-hydrated])') === null
}

async function waitForHydration(timeout: number): Promise<ErrorResult | null> {
  const started = performance.now()
  while (!allIslandsRegistered()) {
    if (performance.now() - started >= timeout) {
      return failure('timeout', `navigation did not hydrate within ${timeout}ms`)
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return null
}

async function waitForTerminal(timeout: number): Promise<ErrorResult | null> {
  const current = getNavState()
  if (current.phase === 'error') {
    return failure('nav-failed', current.error?.message ?? 'navigation failed')
  }
  if (current.phase === 'success' || current.phase === 'idle') return null
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(failure('timeout', `navigation did not settle within ${timeout}ms`))
    }, timeout)
    const off = subscribe((state) => {
      if (state.phase === 'loading') return
      clearTimeout(timer)
      off()
      resolve(
        state.phase === 'error'
          ? failure('nav-failed', state.error?.message ?? 'navigation failed')
          : null,
      )
    })
  })
}

async function finish(
  status: NavResult['status'],
  options: NavigateOptions,
  url = location.href,
): Promise<NavResult | ErrorResult> {
  const timeout = options.timeout ?? 10_000
  if (status === 'spa') {
    const terminalError = await waitForTerminal(timeout)
    if (terminalError) return terminalError
    const hydrationError = await waitForHydration(timeout)
    if (hydrationError) return hydrationError
  }
  const result: NavResult = { ok: true, url, status }
  if (options.struct && status === 'spa') {
    const snapshot = await struct()
    if ('ok' in snapshot && snapshot.ok === false) return snapshot
    result.struct = snapshot
  }
  return result
}

export async function navigate(
  path: string,
  options: NavigateOptions = {},
): Promise<NavResult | ErrorResult> {
  const destination = new URL(path, location.href)
  if (destination.origin !== location.origin) {
    const response = await finish('external', options, destination.href)
    setTimeout(() => location.assign(destination.href), 0)
    return response
  }
  const hasSpaNavigator = _getNavigator() !== null
  if (!hasSpaNavigator) {
    const response = await finish('full-load', options, destination.href)
    setTimeout(() => location.assign(destination.href), 0)
    return response
  }
  await brustNavigate(destination.href)
  // Bootstrap leaves the store in loading when it selected a full-document
  // load; a committed SPA swap updates its path and terminal phase to success.
  const state = getNavState()
  const fullLoad = state.phase === 'loading' && state.path !== destination.pathname
  return finish(fullLoad ? 'full-load' : 'spa', options)
}

async function browserHistoryAction(
  run: () => void,
  options: NavigateOptions = {},
): Promise<NavResult | ErrorResult> {
  const before = location.href
  run()
  await Promise.resolve()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (location.href === before && getNavState().phase !== 'loading') {
    return finish('spa', options)
  }
  const state = getNavState()
  const canonicalPath = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : '/'
  const status = state.path === canonicalPath ? 'spa' : 'full-load'
  return finish(status, options)
}

export function back(options?: NavigateOptions): Promise<NavResult | ErrorResult> {
  return browserHistoryAction(() => history.back(), options)
}

export function reload(options?: NavigateOptions): Promise<NavResult | ErrorResult> {
  return finish('full-load', options ?? {}).then((response) => {
    setTimeout(() => location.reload(), 0)
    return response
  })
}

export async function settleAfterAction(timeout = 10_000): Promise<ErrorResult | null> {
  await Promise.resolve()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (getNavState().phase === 'loading') {
    const navError = await waitForTerminal(timeout)
    if (navError) return navError
    return waitForHydration(timeout)
  }
  return null
}
