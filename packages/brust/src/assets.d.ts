// F411: an import of a font or an image (`SERVED_ASSET_EXT`) is the served URL of the file, `/_brust/client/<name>-<hash>.<ext>`,
// the same URL a stylesheet's `url()` of it is rewritten to (the build's `cssPlugin`). Pulled in by a `/// <reference>` from the
// entries apps import, so `import face from './fonts/face.woff2'` typechecks.
declare module '*.woff2' {
  const url: string
  export default url
}
declare module '*.woff' {
  const url: string
  export default url
}
declare module '*.ttf' {
  const url: string
  export default url
}
declare module '*.otf' {
  const url: string
  export default url
}
declare module '*.eot' {
  const url: string
  export default url
}
declare module '*.png' {
  const url: string
  export default url
}
declare module '*.jpg' {
  const url: string
  export default url
}
declare module '*.jpeg' {
  const url: string
  export default url
}
declare module '*.gif' {
  const url: string
  export default url
}
declare module '*.webp' {
  const url: string
  export default url
}
declare module '*.avif' {
  const url: string
  export default url
}
declare module '*.svg' {
  const url: string
  export default url
}
declare module '*.ico' {
  const url: string
  export default url
}
