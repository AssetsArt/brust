export function home(): string {
  return String(process.env.HOME ?? 'none')
}
