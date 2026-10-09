import * as Icons from './icons'
import Badge from './Badge'

export default function Shapes({ title, count, rest, show }: any) {
  return (
    <div className={`shapes ${show ? 'on' : 'off'}`} data-count={count} {...rest}>
      <h1>
        {title}&nbsp;&mdash;{' '}
        multi-line
        text
      </h1>
      {show && <Badge tone="info">{count}</Badge>}
      {count > 1 ? <b>many</b> : 'one'}
      <Icons.Star />
      <input disabled />
      {null}
    </div>
  )
}
