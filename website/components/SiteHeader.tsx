// The site header: BRUST wordmark with the @brust/core version, and the site nav (no search until search exists).
export default function SiteHeader({ version }: { version: string }) {
  return (
    <div className="wrap">
      <header className="site-header">
        <a className="brand" href="/">
          brust <span className="v">{version}</span>
        </a>
        <nav aria-label="Site">
          <a href="/docs">Docs</a>
          <a href="/docs/cookbook/hello-world">Cookbook</a>
          <a href="https://github.com/AssetsArt/brust">GitHub</a>
        </nav>
      </header>
    </div>
  )
}
