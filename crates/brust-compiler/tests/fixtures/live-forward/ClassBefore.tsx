// A static child with its own `className` BEFORE the spread: the spread's `className` replaces it.
export default function ClassBefore({ ...rest }: any) {
  return <button type="button" className="own" {...rest} />
}
