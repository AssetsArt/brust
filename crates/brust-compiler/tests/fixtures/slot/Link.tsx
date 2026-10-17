// F363a: a static component that spreads its props onto the one element it renders (shadcn's `<Link>` / `<NavLink>`)
export default function Link({ children, className, ...props }: any) {
  return (
    <a className={'link ' + (className ?? '')} {...props}>
      {children}
    </a>
  )
}
