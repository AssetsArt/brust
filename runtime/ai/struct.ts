import { getNavState, type NavPhase } from '../navigation/store.ts'
import { mintRef, resolveTarget, type ErrorResult, type Ref } from './refs.ts'

export interface Field {
  ref: Ref
  name: string
  type: string
  value: string | null
  required: boolean
  options?: Array<{ value: string; label: string }>
}

export interface PageStruct {
  url: string
  path: string
  title: string
  shellId: string
  nav: { phase: NavPhase }
  outline: Array<{ level: number; text: string }>
  links: Array<{ ref: Ref; href: string; text: string; external: boolean; current: boolean }>
  buttons: Array<{
    ref: Ref
    text: string
    disabled: boolean
    kind: 'button' | 'submit' | 'x-on-click'
  }>
  forms: Array<{
    ref: Ref
    name: string | null
    action: string | null
    method: string
    fields: Field[]
  }>
  inputs: Field[]
  islands: Array<{ ref: Ref; name: string; hydrated: boolean }>
  behaviors: Array<{ ref: Ref; name: string }>
}

export interface StructOptions {
  within?: Ref | string
  maxText?: number
}

type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

function isIgnored(element: Element): boolean {
  return element.closest('[data-ai-ignore]') !== null
}

function all<T extends Element>(root: ParentNode, selector: string): T[] {
  const found = Array.from(root.querySelectorAll<T>(selector))
  if (root instanceof Element && root.matches(selector)) found.unshift(root as T)
  return found.filter((element) => !isIgnored(element))
}

function label(element: Element, maxText: number): string {
  const raw =
    element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent ?? ''
  const text = raw.replace(/\s+/g, ' ').trim()
  return text.length > maxText ? text.slice(0, maxText) : text
}

function field(element: FieldElement): Field {
  const redacted =
    (element instanceof HTMLInputElement && element.type === 'password') ||
    element.hasAttribute('data-ai-redact')
  const value = redacted
    ? null
    : element instanceof HTMLSelectElement && element.multiple
      ? Array.from(element.selectedOptions)
          .map((option) => option.value)
          .join(',')
      : element.value
  const options =
    element instanceof HTMLSelectElement
      ? Array.from(element.options).map((option) => ({ value: option.value, label: option.text }))
      : undefined
  return {
    ref: mintRef(element),
    name: element.name || element.getAttribute('x-model') || '',
    type:
      element instanceof HTMLInputElement
        ? element.type
        : element instanceof HTMLSelectElement
          ? 'select'
          : 'textarea',
    value,
    required: element.required,
    ...(options ? { options } : {}),
  }
}

export async function struct(options: StructOptions = {}): Promise<PageStruct | ErrorResult> {
  let root: ParentNode = document
  if (options.within) {
    const resolved = resolveTarget(options.within)
    if (!(resolved instanceof Element)) return resolved
    root = resolved
  }
  const maxText = Math.max(0, options.maxText ?? 200)
  const origin = location.origin
  const forms = all<HTMLFormElement>(root, 'form')
  const links = all<HTMLAnchorElement>(root, 'a[href]').map((anchor) => {
    const url = new URL(anchor.href, location.href)
    return {
      ref: mintRef(anchor),
      href: anchor.href,
      text: label(anchor, maxText),
      external: url.origin !== origin,
      current: anchor.getAttribute('aria-current') === 'page',
    }
  })
  const buttonElements = all<HTMLElement>(
    root,
    'button, input[type="button"], input[type="submit"], [x-on-click]',
  )
  const buttons = [...new Set(buttonElements)].map((button) => ({
    ref: mintRef(button),
    text:
      button instanceof HTMLInputElement
        ? button.value || label(button, maxText)
        : label(button, maxText),
    disabled: 'disabled' in button && Boolean((button as HTMLButtonElement).disabled),
    kind: ((button.matches('button') && (button as HTMLButtonElement).type === 'submit') ||
    button.matches('input[type="submit"]')
      ? 'submit'
      : button.matches('button, input[type="button"]')
        ? 'button'
        : 'x-on-click') as 'button' | 'submit' | 'x-on-click',
  }))
  const standalone = all<FieldElement>(root, 'input, textarea, select').filter(
    (element) => !element.form,
  )
  return {
    url: location.href,
    path: location.pathname,
    title: document.title,
    shellId: document.querySelector('meta[name="brust-shell"]')?.getAttribute('content') ?? '',
    nav: { phase: getNavState().phase },
    outline: all<HTMLHeadingElement>(root, 'h1, h2, h3').map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: label(heading, maxText),
    })),
    links,
    buttons,
    forms: forms.map((formElement) => ({
      ref: mintRef(formElement),
      name:
        formElement.getAttribute('data-ai-name') ||
        formElement.getAttribute('name') ||
        formElement.id ||
        null,
      action: formElement.getAttribute('action'),
      method: (formElement.getAttribute('method') || 'get').toLowerCase(),
      fields: all<FieldElement>(formElement, 'input, textarea, select').map(field),
    })),
    inputs: standalone.map(field),
    islands: all<HTMLElement>(root, '[data-brust-island]').map((island) => ({
      ref: mintRef(island),
      name: island.getAttribute('data-brust-island') ?? '',
      hydrated: island.hasAttribute('data-brust-hydrated'),
    })),
    behaviors: all<HTMLElement>(root, '[x-data]').map((behavior) => ({
      ref: mintRef(behavior),
      name: behavior.getAttribute('x-data') ?? '',
    })),
  }
}
