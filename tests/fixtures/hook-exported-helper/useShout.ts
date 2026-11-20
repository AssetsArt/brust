// F579: an exported plain helper of a hook's module is carried into the chunk (R34.105); F578 D3: a defaulted parameter.
export function shout(x: string) {
  return x.toUpperCase()
}

export function useShout(mark = '!') {
  const say = (x: string) => shout(x) + mark
  return say
}
