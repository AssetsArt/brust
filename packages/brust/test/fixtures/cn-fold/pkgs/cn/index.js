// Stand-in for `cn` (no network): joins the truthy class values.
export function cn(...inputs) {
  return inputs.flat(Infinity).filter(Boolean).join(' ')
}
