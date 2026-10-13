const label = 'module'

export default function Page({ name }: { name: string }) {
  const label = name.toUpperCase()
  return <p>{label}</p>
}
