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
