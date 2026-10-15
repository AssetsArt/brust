import { useCtl } from './use-ctl'
export default function Ord({ pressed, defaultPressed, onPressedChange }: any) {
  const [on, set] = useCtl({ prop: pressed, defaultProp: defaultPressed ?? false, onChange: onPressedChange })
  return <button aria-pressed={on} onClick={() => set(!on)}>x</button>
}
