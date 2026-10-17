import Box from './Box'
// F342 (Mellow F1): static, never linked: forwards its rest (the page's children included) into the native Box.
export default function Mid({ ...rest }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <section>
      <Box {...rest} />
    </section>
  )
}
