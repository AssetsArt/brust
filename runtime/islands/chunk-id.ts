import { createHash } from 'node:crypto'
import { relative } from 'node:path'

/** Content-addressed island id / chunk basename = `<Name>_<8hex(sha256
 * cwd-relative source path)>`. The SINGLE name contract (mirrors the directive
 * chunk scheme): the chunk filename, the `data-brust-island` marker (native
 * rewrite in reconcileIslandManifest + the React island-id onLoad plugin), and
 * the bootstrap import all derive from this — so two same-named components from
 * different files get distinct ids and never collide.
 *
 * Lives in its own module (no `scanImports` dep) so both `islands/build.ts` and
 * `cli/native-routes-emit.ts` can import it without a circular dependency. */
export function islandChunkBasename(name: string, absSourcePath: string): string {
  const rel = relative(process.cwd(), absSourcePath).replaceAll('\\', '/')
  const hash = createHash('sha256').update(rel).digest('hex').slice(0, 8)
  return `${name}_${hash}`
}
