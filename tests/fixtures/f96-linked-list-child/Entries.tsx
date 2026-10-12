export default function Entries({ log }: { log: string[] }) {
  return (
    <ul>
      {log.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  )
}
