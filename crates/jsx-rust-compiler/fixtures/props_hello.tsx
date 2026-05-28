export default function PropsHello({ name, count }: { name: string; count: number }) {
  return (
    <div>
      <h1>Hello,{" "}{name}</h1>
      <p>Count:{" "}{count}</p>
    </div>
  )
}
