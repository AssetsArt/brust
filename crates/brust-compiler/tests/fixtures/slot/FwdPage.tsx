import * as React from 'react'
import Btn from './Btn'
import Link from './Link'

// F363a negative: the page's own forwarded ref is handed to the Slot's child
export default React.forwardRef<HTMLAnchorElement, any>(function FwdPage(_props, ref) {
  return (
    <main>
      <Btn asChild>
        <Link ref={ref}>x</Link>
      </Btn>
    </main>
  )
})
