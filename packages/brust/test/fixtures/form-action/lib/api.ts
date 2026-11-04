import { client } from '@brust/core/client'
import type { App } from '../actions'

export const api = client<App>()
