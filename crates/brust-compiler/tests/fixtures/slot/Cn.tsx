import { cx } from './cx'

export default function Cn({ className, size = 'm', ...props }: any) {
  return <i className={cx(size, className)} {...props} />
}
