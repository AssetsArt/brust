// A package function: async, pure, JSON output. Used through buildTime(…) only.
export async function highlight(code, lang) {
  await Promise.resolve()
  return `<pre data-lang="${lang}"><code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre>`
}
export const table = (n) => Object.fromEntries([...Array(n).keys()].map((i) => [`k${i}`, i * i]))
