<p align="center">
  <a href="https://brust.dev"><img src="website/public/favicon.svg" width="96" height="96" alt="brust"></a>
</p>

<h1 align="center">brust</h1>

<p align="center"><b>React you write. Rust that serves it.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@brust/core"><img src="https://img.shields.io/npm/v/@brust/core/alpha?label=%40brust%2Fcore&color=f2a516" alt="npm"></a>
  <a href="https://github.com/AssetsArt/brust/actions/workflows/ci.yml"><img src="https://github.com/AssetsArt/brust/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-062323" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://brust.dev">Website</a> ·
  <a href="https://brust.dev/docs/quickstart">Quickstart</a> ·
  <a href="https://brust.dev/docs">Docs</a>
</p>

---

brust compiles your React components ahead of time. A page that never changes ships as static HTML, rendered by Rust. Interactive parts become small native handlers. React runs only where the compiler finds it is needed.

```bash
bun create @brust/app my-app
cd my-app && bun install
bun run dev
```

| Tier | What you write | What ships |
|---|---|---|
| **static** | a component with no state | HTML from a compiled template, no JavaScript |
| **native** | `useState`, events, effects | the HTML plus a small handler chunk, no React |
| **react** | what only React can do | a React island, hydrated in place |

Runs on Bun with a Rust server, or on Cloudflare Workers. `brust build --target static` writes plain files for any static host.

## Built with brust

- [assetsart.com](https://assetsart.com): Assets Art, the serverless cloud platform from the team behind brust
- [brust.dev](https://brust.dev): this project's own website and docs
- [ketbill.com](https://ketbill.com): KetBill, Thai accounting documents for SMEs, from quotation to VAT/WHT receipt

## Contributing

Rust `nightly-2026-09-15` (`rust-toolchain.toml`) and Bun 1.4.x.

```bash
cargo test --workspace --exclude bun_react_compiler
cd packages/brust && bun run build:debug && bun test
```

The 0.1.x line (`brustjs` on npm) is kept on the [`v01x`](https://github.com/AssetsArt/brust/tree/v01x) branch.

[MIT](LICENSE) © Assets Art
