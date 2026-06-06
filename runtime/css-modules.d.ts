// Ambient declarations for component CSS imports, so `import styles from
// './X.module.css'` and side-effect `import './globals.css'` typecheck without a
// generated per-file .d.ts in the source tree. The precise key map is resolved
// at runtime by brust's Bun.plugin (built from the component-CSS manifest); the
// per-module precise .d.ts is emitted into the build output (<outDir>/types) for
// reference, not for resolution. This file is a global script (no import/export),
// so the declarations apply across the program.

declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

declare module '*.css' {
  const css: string
  export default css
}
