// A static child that spreads its rest onto its one element, after its own attributes (shadcn-style).
export default function Btn({ variant = 'default', ...rest }: any) {
  return <button data-slot="button" data-variant={variant} {...rest} />
}
