export function cx(...parts: unknown[]): string {
  return parts.filter(Boolean).join(' ')
}
