let calls = 0
export function next(): number {
  calls += 1
  return calls
}
