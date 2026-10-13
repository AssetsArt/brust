export function api(): string {
  return String(import.meta.env.API_URL ?? 'none')
}
export function where(): string {
  return import.meta.url
}
