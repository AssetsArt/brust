// The site 404: a static full document outside the layout (no loader, no scripts), in the site skin.
export default function NotFoundPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Not found · brust</title>
        <link rel="icon" href="/public/favicon.svg" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@300..900&display=swap" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Azeret+Mono:wght@400;500;600;700&display=swap" />
      </head>
      <body>
        <main className="mx-auto grid min-h-screen max-w-[1160px] content-center gap-5 px-4 py-16">
          <a className="flex items-center gap-[.6rem] font-display text-[19px] font-semibold uppercase tracking-[.14em] text-ink no-underline" href="/">
            brust
          </a>
          <h1 className="text-[clamp(2.6rem,6vw,4.5rem)] font-light uppercase leading-[.96]">Page not found</h1>
          <p className="text-ink-2">Nothing is served at this address.</p>
          <div className="cta">
            <a className="btn primary" href="/">
              Back to the start
            </a>
            <a className="btn" href="/docs">
              Read the docs
            </a>
          </div>
        </main>
      </body>
    </html>
  )
}
