import { defineStore, signal } from '@brust/core/store'

/** F533: each /i/N loader writes `id`; `count` is only ever written by the client, so a navigation keeps it. */
export const item = defineStore('item', () => ({ id: signal('0'), count: signal(0) }))
