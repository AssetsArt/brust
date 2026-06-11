// The Home unified-store demo's store — ONE named store shared by the React
// island (UnifiedIsland, via useStore) and the react-free native behaviors
// (UnifiedNative, UnifiedStoreNode). `defineStore` resolves every importing
// bundle to the same instance on window.__BRUST_STORES__['docs.unified'], so
// the paradigms read and write the same signal with no bridge code — the
// landing-page claim, executed by the landing page. See content/store.md.
import { defineStore, signal } from 'brustjs/store'

export const unifiedStore = defineStore('docs.unified', () => {
  const count = signal(0)
  return { count }
})
