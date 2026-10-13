// shadcn's Button without `asChild`: named props, then `...props` spread after its own attributes.
export default function Btn({ className, variant = 'default', ...props }: any) {
  return <button data-slot="button" data-variant={variant} className={className} {...props} />
}
