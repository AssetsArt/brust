export default function Box({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="box" className={className} {...props} />
}
