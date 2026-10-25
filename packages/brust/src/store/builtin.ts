// Store modules brust ships. The compiler names them by package specifier (`StoreRef.module`) instead of an app-relative
// path, so the manifest's `stores`, the `jobs.js` stores table and the loader's `touchStores` all use this spelling.
export const NAVIGATION_MODULE = '@brust/core/navigation'
export const BUILTIN_STORE_MODULES: readonly string[] = [NAVIGATION_MODULE]
