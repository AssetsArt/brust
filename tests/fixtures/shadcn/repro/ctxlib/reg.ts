// F215 (Mellow V1): a stand-in package (a bare specifier through tsconfig paths) that calls what it is handed at load time
// and changes the object it returns.
export function later(f: () => { v: string }) {
  f().v = 'b'
  return 0
}

// F215 (Mellow V3): changes the object it is handed.
export function register(o: { v: string }) {
  o.v = 'b'
  return 0
}
