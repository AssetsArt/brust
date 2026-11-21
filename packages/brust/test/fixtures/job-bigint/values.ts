// F585: a bigint picked by the route param so the build cannot fold it (a job computes it).
export function f(x: string): any {
  switch (x) {
    case 'big': return 10n
    case 'zerobig': return 0n
    default: return 42
  }
}
