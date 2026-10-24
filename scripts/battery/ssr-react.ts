// F386: React's `renderToString` of a battery row's default export (the reference side of ssr-compare.ts).
//   bun scripts/battery/ssr-react.ts <input.tsx> <props.json>
// react and react-dom resolve from the row's own node_modules (the caller links the installed ones there).
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

// a row's own console output (a module side effect) is not markup
console.log = console.error
const [file, propsFile] = process.argv.slice(2)
const req = createRequire(resolve(file!))
const { createElement } = req('react')
const { renderToString } = req('react-dom/server')
const mod = await import(resolve(file!))
const props = JSON.parse(await Bun.file(propsFile!).text())
if (typeof mod.default !== 'function' && typeof mod.default !== 'object') throw new Error(`${dirname(file!)}: no default export`)
process.stdout.write(renderToString(createElement(mod.default, props)))
