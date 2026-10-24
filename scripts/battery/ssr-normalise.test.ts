import { expect, test } from 'bun:test'
import { firstDifference, normalise } from './ssr-normalise.ts'

const same = (brust: string, react: string) => expect(firstDifference(normalise(brust), normalise(react))).toBeNull()
const differ = (brust: string, react: string) => expect(firstDifference(normalise(brust), normalise(react))).not.toBeNull()

test('brust markers drop: directives, wrappers, comments, text-binding spans', () => {
  same(`<div x-data="a" x-props='{}'><button x-on-click="_h1">go<span x-text="_c1">0</span></button></div>`, `<div><button>go<!-- -->0</button></div>`)
  same(`<brust-host style="display:contents" x-data="a"><p>x</p></brust-host>`, `<p>x</p>`)
  same(`<ul><!--x-for--><li x-for="i in l">a</li></ul>`, `<ul><li>a</li></ul>`)
})

test('attribute order and entity spelling do not matter, content does', () => {
  same(`<a href="/x" class="a  b">t &amp; u</a>`, `<a class="a b" href="/x">t &#38; u</a>`)
  differ(`<a href="/x">t</a>`, `<a href="/y">t</a>`)
  differ(`<p>a</p>`, `<p>b</p>`)
  differ(`<p class="x"></p>`, `<p></p>`)
})

test('a hidden x-* copy is brust\'s client toggle; a plain hidden element is content', () => {
  same(`<div><p x-if="c" hidden>body</p></div>`, `<div></div>`)
  differ(`<div><p hidden>body</p></div>`, `<div></div>`)
})

test('document-level elements and the route envelope props drop', () => {
  same(`<div path="/x" params="{}">x</div><script type="module" src="/a.js"></script>`, `<title>t</title><div params="[object Object]" path="/x">x</div>`)
})

test('useId values are compared by identity, not spelling', () => {
  same(`<label for="brust-r1-input_ab-1">n</label><input id="brust-r1-input_ab-1">`, `<label for="_R_0_">n</label><input id="_R_0_"/>`)
  differ(`<label for="brust-r1-input_ab-1">n</label><input id="brust-r1-input_ab-2">`, `<label for="_R_0_">n</label><input id="_R_0_"/>`)
})

test('React\'s form action placeholder drops', () => {
  same(`<form>x</form>`, `<form action="javascript:throw new Error('React form unexpectedly submitted.')">x</form>`)
})
