export const SHARED_STORE_MARK = { hits: 0 }
export function bump() {
  SHARED_STORE_MARK.hits++
  return SHARED_STORE_MARK.hits
}
