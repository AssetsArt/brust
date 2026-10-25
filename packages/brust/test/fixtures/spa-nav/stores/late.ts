import { defineStore, signal } from '@brust/core/store'

/** First used on /store-b: a tab that comes from /store-a seeds it from /store-b's snapshot. */
export const late = defineStore('late', () => ({ v: signal(0) }))
