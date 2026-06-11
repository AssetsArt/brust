# PRODUCT — brust docs site

**Product.** The official documentation site for brust — a native-first web
framework that compiles JSX to Rust-rendered templates and hydrates only where
it counts. The site is itself a brust app (`example/docs`), dogfooding the
markdown pipeline (`mdRoutes` / `mdNav`), native behaviors, islands, and SSG.

**Audience.** Developers evaluating brust ("is this worth my weekend?") and
developers already using it ("what's the loader signature again?"). Both read
docs at night next to an editor — dark theme is the default.

**Registers.**

- **Home (`/`) = brand register.** One landing page that earns attention: the
  grainient hero, the name in solid brand green, a real measured number. It can
  be expressive — once.
- **Docs (`/docs/*`) = product register.** Chrome disappears; content wins.
  Solid header, quiet sidebar, generous measure, zero decoration that doesn't
  carry information.

**Voice words:** *fast, plainspoken, engineered.*

- *Fast* — short sentences, numbers over adjectives, no throat-clearing.
- *Plainspoken* — say what the API does; never "powerful", "seamless",
  "delightful". If a claim can't be verified against `runtime/` source, cut it.
- *Engineered* — precision signals care: exact signatures, exact file paths,
  exact constraints (including brust's own limitations, stated plainly).

**Non-goals (v1).** Full-text search (titles + headings only), versioned docs,
i18n, deploy automation.
