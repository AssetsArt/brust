import Layout from '../components/Layout'

interface NativeData {
  name: string
}

// `native: true` route — at build time this JSX is compiled to a jinja template
// and rendered in Rust (minijinja), skipping React on the server entirely. Keep
// it "jinja-able": plain prop interpolation, no hooks or client-side logic. The
// route's loader return value becomes `data`.
export default function NativeHello({ data }: { data: NativeData }) {
  return (
    <Layout title={`Native: ${data.name}`}>
      <h1 className="text-3xl font-bold mb-4">Hello, {data.name}</h1>
      <p className="mb-4 text-gray-700">
        This page was rendered <strong>entirely in Rust</strong> (minijinja) — no React on the
        server.
      </p>
      <p>
        <a className="text-blue-600 underline" href="/">
          ← back home
        </a>
      </p>
    </Layout>
  )
}
