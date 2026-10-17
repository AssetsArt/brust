export const ITEMS = [{ id: 1, name: 'a', secret: 'SECRET_A' }, { id: 2, name: 'b', secret: 'SECRET_B' }]
export function add(name: string) {
  ITEMS.push({ id: ITEMS.length + 1, name, secret: 'SECRET_C' })
}
