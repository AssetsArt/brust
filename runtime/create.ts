// Public entry for the `create-brustjs` package (`bun create brustjs <dir>`).
// Kept as a thin re-export so the create package never reaches into brust's
// CLI internals and the templates stay owned by this package alone.
export { runNew } from './cli/new.ts'
