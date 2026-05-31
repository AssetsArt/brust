// Test fixture for resolveComponentContext. A factory that renders a <p>
// element containing ctx.greeting. Uses createElement (no JSX) so it
// transpiles trivially, and imports from the project's react so bare
// specifiers resolve correctly from within the in-repo fixture directory.
import { createElement as h } from 'react'

export const factories: Array<(ctx: any) => any> = [(ctx: any) => h('p', null, ctx.greeting)]
