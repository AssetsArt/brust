// shadcn's shape: named props, then `...props` spread after the component's own attributes.
export default function Card({ className, ...props }: any) {
  return <div data-slot="card" className={className} {...props} />
}
