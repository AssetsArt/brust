// Case 13: runs nothing at load (a function that writes a module binding runs only when called).
let count = 0
export function bump(): number {
  count += 1
  return count
}
