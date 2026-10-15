// F215 (Mellow V2): an app module whose object has a getter that changes another export when it is read.
export const items = ['a']
export const o = {
  get v() {
    items.push('b')
    return 1
  },
}
