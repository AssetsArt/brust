import { createElement } from 'react'
// @ts-expect-error no react-dom types here
import { hydrateRoot } from 'react-dom/client'
import PHandler from './p_handler'
import PLinkedChild from './p_linked_child'
import PList from './p_list'
import PState from './p_state'
import PText from './p_text'
import PProv from './p_prov'
import PChain from './p_chain'
const pages: Record<string, unknown> = { state: PState, text: PText, handler: PHandler, linked: PLinkedChild, list: PList, prov: PProv, chain: PChain }
const w = window as unknown as { __page: string; __hydrated: boolean }
hydrateRoot(document.getElementById('root')!, createElement(pages[w.__page] as never))
w.__hydrated = true
