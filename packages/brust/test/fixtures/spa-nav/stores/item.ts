import { defineStore, signal } from '@brust/core/store'

/** F533: each /i/N loader writes `id`; `count` is only ever written by the client, so a navigation keeps it. F534: the
 * loader also writes `meta`, an object, so the island's effect on it shows whether it saw one identity or two. */
export const item = defineStore('item', () => ({ id: signal('0'), count: signal(0), meta: signal<{ id: string }>({ id: '0' }) }))
