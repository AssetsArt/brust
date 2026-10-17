import { ITEMS } from './data_store'
// Pushes into the data module's own list: rows the page re-creates must see it, as React's next render does.
export function addItem(): void {
  const n = ITEMS.length + 1
  ITEMS.push({ id: n, name: `item${n}`, secret: 'SECRET_X' })
}
