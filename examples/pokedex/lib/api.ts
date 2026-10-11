// examples/pokedex/lib/api.ts — browser-safe; the App import is type-only (the elysia lane's browser guard refuses a value import).
import { client } from '@brust/core/client'
import type { App } from '../actions'

export const api = client<App>()
