// Hands its rest to a helper as a value: React already (`prop-pattern`).
export default function RestJson({ ...rest }: any) {
  return <button {...rest}>{JSON.stringify(rest)}</button>
}
