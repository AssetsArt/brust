import { BrustPage } from 'brustjs'

// Minimal placeholder shell — task 1.5 replaces this with the grainient hero.
// Native route: single return, no local bindings.
export default function Home() {
  return (
    <BrustPage
      title="brust — native-first web framework"
      description="brust compiles JSX to Rust-rendered templates and hydrates only where it counts."
    >
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-4 px-6">
        <h1 className="text-4xl font-bold tracking-tight text-link">brust</h1>
        <p className="text-fg-muted">
          A native-first web framework: JSX compiled to Rust-rendered templates, hydration only
          where it counts.
        </p>
        <a className="text-link underline underline-offset-4" href="/docs">
          Read the docs
        </a>
      </main>
    </BrustPage>
  )
}
