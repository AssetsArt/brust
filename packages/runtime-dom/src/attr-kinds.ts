// GENERATED from crates/brust-jinja/src/lib.rs (BOOLEAN_ATTRS, OVERLOADED_ATTRS, STRINGIFY_ATTRS); do not edit.
// Regenerate: bun scripts/gen-attr-kinds.ts. test/attr-kinds.test.ts fails when this drifts.
const set = (s: string): Set<string> => new Set(s.split(' '))
export const BOOLEAN = set('allowfullscreen async autofocus autoplay checked controls default defer disabled disablepictureinpicture disableremoteplayback formnovalidate hidden inert itemscope loop multiple muted nomodule novalidate open playsinline readonly required reversed scoped seamless selected')
export const OVERLOADED = set('capture download')
export const STRINGIFY = set('autoreverse contenteditable draggable externalresourcesrequired focusable preservealpha spellcheck value')
