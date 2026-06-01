// Spike input — minimal JSX subset to validate the compiler pipeline.
export default function MinimalHello({ name, greeting }: { name: string; greeting: string }) {
  return (
    <div className="greeting">
      <h1>
        {greeting}, {name}!
      </h1>
      <p>Welcome to brust.</p>
      <a href="/blog" className="link">
        Read the blog
      </a>
    </div>
  )
}
