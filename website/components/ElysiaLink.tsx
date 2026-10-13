// The first mention of Elysia on a page links to its site, in a new tab.
export default function ElysiaLink({ label = 'Elysia' }: { label?: string }) {
  return (
    <a href="https://elysiajs.com/" target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  )
}
