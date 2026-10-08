export default function Names({ names }: { names: string[] }) {
  return (
    <ol>
      {names.map((name) => (
        <li>{name}</li>
      ))}
    </ol>
  )
}
