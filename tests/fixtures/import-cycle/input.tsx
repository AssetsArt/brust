import Branch from './A'

export default function Tree({ depth }: { depth: number }) {
  return (
    <div>
      <Branch depth={depth} />
    </div>
  )
}
