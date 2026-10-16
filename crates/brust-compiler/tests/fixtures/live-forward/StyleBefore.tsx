// A static child with its own `style` BEFORE the spread: the spread's `style` replaces it (React never merges them).
export default function StyleBefore({ ...rest }: any) {
  return <button type="button" style={{ color: 'red' }} {...rest} />
}
