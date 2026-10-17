export function cn(...xs: (string | false | undefined)[]) {
  return xs.filter(Boolean).join(' ')
}
