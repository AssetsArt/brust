import { settleAfterAction } from './navigate.ts'
import { resolveTarget, type ActionTarget, type ErrorResult } from './refs.ts'

export interface CapturedError {
  message: string
  stack?: string
}

export interface ActionResult {
  ok: true
  navigated: boolean
  url: string
  errors: CapturedError[]
}

type ActionResponse = ActionResult | ErrorResult
type Fillable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement

const activeCaptures = new Set<CapturedError[]>()
let consoleWrapped = false
let listenerWindow: Window | null = null

function captured(value: unknown): CapturedError {
  if (value instanceof Error)
    return { message: value.message, ...(value.stack ? { stack: value.stack } : {}) }
  return { message: typeof value === 'string' ? value : String(value) }
}

function record(value: unknown): void {
  const entry = captured(value)
  for (const errors of activeCaptures) errors.push(entry)
}

function beginCapture(): CapturedError[] {
  if (!consoleWrapped) {
    consoleWrapped = true
    const original = console.error.bind(console)
    console.error = (...args: unknown[]) => {
      record(args.length === 1 ? args[0] : args.map((arg) => captured(arg).message).join(' '))
      original(...args)
    }
  }
  if (listenerWindow !== window) {
    listenerWindow = window
    window.addEventListener('error', (event) => record(event.error ?? event.message))
    window.addEventListener('unhandledrejection', (event) => record(event.reason))
  }
  const errors: CapturedError[] = []
  activeCaptures.add(errors)
  return errors
}

function badInput(message: string, hint?: string): ErrorResult {
  return { ok: false, error: { code: 'bad-input', message, ...(hint ? { hint } : {}) } }
}

function prepare(target: ActionTarget): Element | ErrorResult {
  const element = resolveTarget(target)
  if ('ok' in element) return element
  element.scrollIntoView?.({ block: 'center', inline: 'center' })
  return element
}

async function result(beforeUrl: string, errors: CapturedError[]): Promise<ActionResponse> {
  const settleError = await settleAfterAction()
  activeCaptures.delete(errors)
  if (settleError) return settleError
  return { ok: true, navigated: location.href !== beforeUrl, url: location.href, errors }
}

function event(name: string, EventType: typeof Event = Event): Event {
  return new EventType(name, { bubbles: true, cancelable: true })
}

export async function click(target: ActionTarget): Promise<ActionResponse> {
  const element = prepare(target)
  if ('ok' in element) return element
  const before = location.href
  const errors = beginCapture()
  const Pointer = globalThis.PointerEvent ?? MouseEvent
  element.dispatchEvent(event('pointerdown', Pointer))
  element.dispatchEvent(event('pointerup', Pointer))
  element.dispatchEvent(event('click', MouseEvent))
  return result(before, errors)
}

export async function focus(target: ActionTarget): Promise<ActionResponse> {
  const element = prepare(target)
  if ('ok' in element) return element
  const before = location.href
  if (!(element instanceof HTMLElement)) return badInput('focus target is not an HTMLElement')
  const errors = beginCapture()
  element.focus()
  return result(before, errors)
}

export async function blur(target: ActionTarget): Promise<ActionResponse> {
  const element = prepare(target)
  if ('ok' in element) return element
  const before = location.href
  if (!(element instanceof HTMLElement)) return badInput('blur target is not an HTMLElement')
  const errors = beginCapture()
  element.blur()
  return result(before, errors)
}

function setNativeValue(element: Fillable, value: string): ErrorResult | null {
  if (element.isContentEditable) {
    element.textContent = value
    return null
  }
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : null
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) return badInput('fill target is not an input, textarea, select, or contenteditable')
  setter.call(element, value)
  return null
}

async function fillElement(element: Element, value: string): Promise<ErrorResult | null> {
  if (!(element instanceof HTMLElement)) return badInput('fill target is not an HTMLElement')
  const error = setNativeValue(element, value)
  if (error) return error
  element.dispatchEvent(event('input', InputEvent))
  element.dispatchEvent(event('change'))
  return null
}

export async function fill(target: ActionTarget, value: unknown): Promise<ActionResponse> {
  const element = prepare(target)
  if ('ok' in element) return element
  if (typeof value !== 'string' && typeof value !== 'number') {
    return badInput('fill value must be a string or number')
  }
  const before = location.href
  const errors = beginCapture()
  const error = await fillElement(element, String(value))
  if (error) {
    activeCaptures.delete(errors)
    return error
  }
  return result(before, errors)
}

function findForm(nameOrRef: string): HTMLFormElement | ErrorResult {
  if (/^e\d+$/.test(nameOrRef)) {
    const resolved = resolveTarget(nameOrRef)
    if ('ok' in resolved) return resolved
    return resolved instanceof HTMLFormElement ? resolved : badInput(`${nameOrRef} is not a form`)
  }
  const matches = Array.from(document.forms).filter(
    (candidate) =>
      candidate.getAttribute('data-ai-name') === nameOrRef ||
      candidate.name === nameOrRef ||
      candidate.id === nameOrRef,
  )
  if (matches.length === 0) {
    const resolved = resolveTarget(nameOrRef)
    if ('ok' in resolved) return resolved
    return resolved instanceof HTMLFormElement
      ? resolved
      : badInput(`${nameOrRef} does not resolve to a form`)
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: { code: 'ambiguous', message: `multiple forms named: ${nameOrRef}` },
    }
  }
  return matches[0]!
}

export async function form(
  nameOrRef: string,
  values: Record<string, unknown>,
  options: { submit?: boolean } = {},
): Promise<ActionResponse> {
  const formElement = findForm(nameOrRef)
  if ('ok' in formElement) return formElement
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return badInput('form values must be an object')
  }
  const fields = Array.from(formElement.elements).filter(
    (element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement,
  )
  const errors = beginCapture()
  const available = [...new Set(fields.map((field) => field.name).filter(Boolean))]
  for (const [name, value] of Object.entries(values)) {
    const matching = fields.filter((field) => field.name === name)
    if (matching.length === 0) {
      activeCaptures.delete(errors)
      return badInput(`unknown form field: ${name}`, `available fields: ${available.join(', ')}`)
    }
    const field = matching[0]!
    if (
      field instanceof HTMLInputElement &&
      (field.type === 'checkbox' || field.type === 'radio')
    ) {
      const checked = typeof value === 'boolean' ? value : String(value) === field.value
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')
      descriptor?.set?.call(field, checked)
      field.dispatchEvent(event('input', InputEvent))
      field.dispatchEvent(event('change'))
    } else {
      const error = await fillElement(field, String(value ?? ''))
      if (error) {
        activeCaptures.delete(errors)
        return error
      }
    }
  }
  const before = location.href
  if (options.submit !== false) formElement.requestSubmit()
  return result(before, errors)
}

export async function press(target: ActionTarget, key: string): Promise<ActionResponse> {
  const element = prepare(target)
  if ('ok' in element) return element
  if (!key) return badInput('key must be a non-empty string')
  const before = location.href
  const errors = beginCapture()
  for (const type of ['keydown', 'keypress', 'keyup']) {
    element.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
  }
  return result(before, errors)
}

export async function select(target: ActionTarget, valueOrLabel: string): Promise<ActionResponse> {
  const element = prepare(target)
  if ('ok' in element) return element
  if (!(element instanceof HTMLSelectElement)) return badInput('select target is not a select')
  const option = Array.from(element.options).find(
    (candidate) => candidate.value === valueOrLabel || candidate.text === valueOrLabel,
  )
  if (!option) return badInput(`select option not found: ${valueOrLabel}`)
  const before = location.href
  const errors = beginCapture()
  const error = setNativeValue(element, option.value)
  if (error) {
    activeCaptures.delete(errors)
    return error
  }
  element.dispatchEvent(event('input', InputEvent))
  element.dispatchEvent(event('change'))
  return result(before, errors)
}

export async function check(target: ActionTarget, checked: boolean): Promise<ActionResponse> {
  const element = prepare(target)
  if ('ok' in element) return element
  if (!(element instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(element.type)) {
    return badInput('check target is not a checkbox or radio input')
  }
  const before = location.href
  const errors = beginCapture()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set
  setter?.call(element, checked)
  element.dispatchEvent(event('input', InputEvent))
  element.dispatchEvent(event('change'))
  return result(before, errors)
}
