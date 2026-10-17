// F342 + F309: static; linked where `on` changes, and its rest carries the children onto its root.
export default function Label({ on, ...rest }: { on: boolean } & React.ComponentPropsWithoutRef<'span'>) {
  return <span {...rest} data-on={on ? 'yes' : 'no'} />
}
