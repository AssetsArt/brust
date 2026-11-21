// F585: a bigint in LOADER data is not converted: the page keeps today's loud failure.
export default function LoaderPage({ big }: { big: bigint }) {
  return (
    <div>
      <p>{big + 1n}</p>
    </div>
  )
}
