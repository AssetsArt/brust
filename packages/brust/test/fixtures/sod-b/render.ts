import { createElement } from 'react'
import PHandler from './p_handler'
import PLinkedChild from './p_linked_child'
import PList from './p_list'
import PState from './p_state'
import PText from './p_text'
import PProv from './p_prov'
import PChain from './p_chain'
const server = (await import('react-dom/server')) as unknown as { renderToString(el: unknown): string }
const pages: Record<string, unknown> = { state: PState, text: PText, handler: PHandler, linked: PLinkedChild, list: PList, prov: PProv, chain: PChain }
export const renderPage = (p: string): string => server.renderToString(createElement(pages[p] as never))
