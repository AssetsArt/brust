// F363a negative: it does not spread its props, so a Slot's props would be dropped
export default function Plain({ children }: any) {
  return <a>{children}</a>
}
