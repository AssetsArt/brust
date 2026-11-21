// F585: the values JSON cannot carry, picked by the route param so the build cannot fold them (a job computes them).
export function f(x: string, _n?: number): any {
  switch (x) {
    case 'nan': return NaN
    case 'inf': return Infinity
    case 'ninf': return -Infinity
    case 'negzero': return -0
    case 'big': return 10n
    case 'zerobig': return 0n
    // Object-like values (the dev print warning; React itself throws or prints [object …] there).
    case 'obj': return { a: 1, b: 'x' }
    case 'date': return new Date(0)
    case 'map': return new Map([['a', 1]])
    case 'set': return new Set([1, 2])
    case 'own': return { '\u0000js': 'NaN' }
    default: return 42
  }
}

export function g(x: string): any[] {
  return [f(x), 1]
}
