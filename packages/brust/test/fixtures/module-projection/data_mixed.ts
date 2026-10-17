// F362 PR2 (Afrojack): the page imports the list AND another export of the same module.
export const ITEMS = [
  { id: 1, name: 'one', secret: 'SECRET_A' },
  { id: 2, name: 'two', secret: 'SECRET_B' },
]
export const pick = (id: number): number => id
