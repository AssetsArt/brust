// shadcn's Input: every prop spread onto a text field (onChange listens to `input`, as React).
export default function Field({ className, ...props }: any) {
  return <input data-slot="input" className={className} {...props} />
}
