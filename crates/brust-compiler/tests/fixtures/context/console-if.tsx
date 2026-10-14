export default function Page({ n }: { n?: number }) {
  if (n !== undefined && n < 0) {
    console.error('negative')
  } else if (n === 0) {
    console.warn('zero')
  }
  return <p>{n}</p>
}
