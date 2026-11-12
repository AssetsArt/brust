// F536: the other process of the race test: prepares the package sources of one app in a loop, alternating two package
// sets so a directory is created and pruned again and again beside the reader.
import { preparePackageSources } from '../../src/build/pkg-src'

declare const self: Worker
self.onmessage = (e: MessageEvent<{ root: string; rounds: number }>) => {
  const { root, rounds } = e.data
  for (let i = 0; i < rounds; i++) preparePackageSources(root, i % 2 === 0 ? ['leafy', 'other'] : ['leafy'])
  postMessage('done')
}
