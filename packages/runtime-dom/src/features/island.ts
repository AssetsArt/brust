// React island hydration glue. Registers on the core's island hooks; hosts already in the document when this module
// arrives (the core mounts first) are scheduled right away.
import { islandHooks } from '../core-api'
import { scheduleIslands, cancelIslands } from '../island'
islandHooks.schedule = scheduleIslands
islandHooks.cancel = cancelIslands
if (typeof document !== 'undefined') scheduleIslands(document.documentElement)
export { defineIsland } from '../island'
export type { IslandHydrate } from '../island'
