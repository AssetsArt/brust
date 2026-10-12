/** `host:port` of a Redis URL, never the userinfo, path or query (a URL may carry a password). */
export function redact(url: string): string {
  try {
    const u = new URL(url)
    if (!u.hostname) return '<invalid url>'
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return '<invalid url>'
  }
}
