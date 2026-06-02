// Importmap + bootstrap script tags injected into HTML responses that
// use <Island>. Extracted from runtime/routes.ts so renderBranchStreaming
// can prepend it during the buffering-sink final assembly.
export const ISLANDS_IMPORTMAP_AND_BOOTSTRAP =
  '<script type="importmap">' +
  JSON.stringify({
    imports: {
      // Both react and react/jsx-runtime resolve to the SAME chunk; the
      // chunk re-exports both surfaces. Browser fetches it once and slices
      // different named exports for each import statement.
      react: '/_brust/islands/_react.js',
      'react/jsx-runtime': '/_brust/islands/_react.js',
      'react-dom/client': '/_brust/islands/_react-dom.js',
    },
  }) +
  '</script>' +
  '<script type="module" src="/_brust/islands/_bootstrap.js" defer></script>'

// Directive runtime loader — baked into a native template's .jinja when it uses
// any x-data directive. Served from the same /_brust/islands/ static route as the
// island chunks (underscore-prefixed → passes is_safe_island_filename).
export const DIRECTIVES_BOOTSTRAP =
  '<script type="module" src="/_brust/islands/_directives.js" defer></script>'
