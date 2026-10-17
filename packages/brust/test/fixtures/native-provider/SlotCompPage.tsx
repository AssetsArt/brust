import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'

// F363a: `asChild` of a static component over a static COMPONENT child. Radix's Slot clones the child with the component's
// element attributes as props (className joined), and the child prints them where it spreads its props.
function Btn({ asChild, className, ...props }: { asChild?: boolean; className?: string; children?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="btn" className={'base ' + (className ?? '')} {...props} />
}

function Link({ children, className, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={'link ' + (className ?? '')} {...props}>
      {children}
    </a>
  )
}

// F369a: components that only hand their whole rest to the one polymorphic child (Radix `RovingFocusGroup.Item` shape)
function Carrier({ tone = 'a', ...rest }: { tone?: string } & React.ComponentProps<typeof Btn>) {
  return <Btn data-tone={tone} {...rest} />
}
function Carrier2({ size = 'm', ...rest }: { size?: string } & React.ComponentProps<typeof Carrier>) {
  return <Carrier data-size={size} {...rest} />
}

export default function SlotCompPage() {
  return (
    <main>
      <Btn asChild className="x" id="slot">
        <Link href="/go" id="mine" className="y">
          Go
        </Link>
      </Btn>
      <Btn>plain</Btn>
      <Carrier2 asChild className="c">
        <b id="carried">carried</b>
      </Carrier2>
      <Carrier2>plain carrier</Carrier2>
      <Carrier asChild>
        <Link href="/via-carrier">carrier link</Link>
      </Carrier>
    </main>
  )
}
