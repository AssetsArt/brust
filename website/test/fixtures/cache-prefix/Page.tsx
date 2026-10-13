// A page whose body shows how many times its loader ran (per worker; the capture runs one worker), so a HIT is visible in the body too.
export default function Page({ label, n }: { label: string; n: number }) {
  return (
    <p>
      {label} render {n}
    </p>
  )
}
