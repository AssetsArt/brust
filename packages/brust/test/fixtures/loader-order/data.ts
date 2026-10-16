// What the loader returns: the worker writes it with JSON.stringify, so these keys keep THIS order in the response.
// F322: the two variants differ only in key order. F321: integer-like keys enumerate first, ascending.
const mk = (marginFirst: boolean) => ({
  style: marginFirst ? { margin: 0, marginTop: 5, color: 'red' } : { marginTop: 5, margin: 0, color: 'red' },
  table: { b: 'bee', 10: 'ten', 2: 'two', a: 'ay' },
})
export const variant = (o: string | null) => mk(o === 'b')
// a literal in the source: integer-like keys written out of order
export const literal = { 10: 'ten', 2: 'two', b: 'bee' }
