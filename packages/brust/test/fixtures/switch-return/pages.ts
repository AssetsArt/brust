import P_state from './p_state'
import P_static from './p_static'
import P_strict from './p_strict'

export const pages: Record<string, unknown> = { static: P_static, strict: P_strict, state: P_state }
