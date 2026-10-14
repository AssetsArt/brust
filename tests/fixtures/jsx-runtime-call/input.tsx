import { jsx } from 'react/jsx-runtime'

export default function Hand({ cls }: { cls: string }) {
  return jsx('div', { className: cls, children: 'x' })
}
