// The canon footer: wordmark and licence, then Docs / Project / Packages link columns.
export default function SiteFooter() {
  return (
    <div className="wrap">
      <footer className="site">
        <div>
          <a className="brand" href="/">
            brust
          </a>
          <p>React components compiled ahead of time, served by Rust. MIT License.</p>
        </div>
        <div>
          <h4>Docs</h4>
          <a href="/docs/quickstart">Quickstart</a>
          <a href="/docs/routing">Routing</a>
          <a href="/docs/rendering-tiers">Rendering tiers</a>
          <a href="/docs/cookbook/hello-world">Cookbook</a>
        </div>
        <div>
          <h4>Project</h4>
          <a href="https://github.com/AssetsArt/brust">GitHub</a>
          <a href="https://github.com/AssetsArt/brust/releases">Releases</a>
          <a href="https://github.com/AssetsArt/brust/commits/v2">Changelog</a>
        </div>
        <div>
          <h4>Packages</h4>
          <a href="https://www.npmjs.com/package/@brust/core">@brust/core on npm</a>
          <a href="https://www.npmjs.com/package/@brust/create-app">@brust/create-app</a>
        </div>
      </footer>
    </div>
  )
}
