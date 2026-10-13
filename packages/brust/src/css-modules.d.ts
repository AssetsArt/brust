// L19 (R19.4): a `.module.css` import is its class map (the build's `cssPlugin`); any other `.css`
// import is a side-effect import the server links (R19.3). Pulled in by a `/// <reference>` from the
// entries apps import, so both forms typecheck.
declare module '*.module.css' {
  const classes: { readonly [name: string]: string }
  export default classes
}
declare module '*.css' {}
