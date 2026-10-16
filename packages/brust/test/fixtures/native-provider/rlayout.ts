import * as React from 'react'

// Radix's `use-layout-effect`: React's hook where there is a document, nothing on a server
export const useLayoutEffect = globalThis?.document ? React.useLayoutEffect : () => {}
