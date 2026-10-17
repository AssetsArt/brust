// F362 PR2: a data module a page imports its rows from; `secret` is never read by the client.
export const ITEMS = [
  { id: 1, name: 'one', secret: 'SECRET_A' },
  { id: 2, name: 'two', secret: 'SECRET_B' },
  { id: 3, name: 'three', secret: 'SECRET_C' },
]
export const OTHER = 'SECRET_OTHER'
