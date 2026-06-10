// md-pages build fixture — exercised by tests/cli-build.test.ts. A minimal app
// whose ONLY pages come from mdRoutes(), with an island used ONLY from md
// content (so the chunk can only exist if the build threads emitMdTemplates'
// mdIslands into scanIslandChunks — task 2.8).
import { brust } from '../../../runtime/index.ts'
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url })
