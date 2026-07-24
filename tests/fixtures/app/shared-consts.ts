// Shared data module with MULTIPLE exported consts, imported together by
// NativeStaticEval.tsx — regression fixture for the multi-ident-per-file
// componentSources fix (a second named import from the same file used to be
// dropped and fail static evaluation).
export const SHARED_NAV = [
  { href: '/one', label: 'shared-nav-one' },
  { href: '/two', label: 'shared-nav-two' },
]

export const SHARED_POLICY = [{ href: '/p-one', label: 'shared-policy-one' }]
