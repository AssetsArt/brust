import { useId } from 'react'

// F363a negative: a child with a `useId` (a server-fed instance record cannot be inlined into the Slot's place)
export default function Fed({ children, ...props }: any) {
  const id = useId()
  return (
    <a id={id} {...props}>
      {children}
    </a>
  )
}
