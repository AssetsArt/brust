// F511: a store-reactive list (each row reads `sel.active`) whose rows render the 38-case switch of Icon.tsx.
import { useStore } from '@brust/core/store/react'
import { Icon } from './Icon'
import { sel } from './store'

const ITEMS = [
  { key: 'k0', label: 'L0' },
  { key: 'k1', label: 'L1' },
  { key: 'k2', label: 'L2' },
  { key: 'k3', label: 'L3' },
  { key: 'k4', label: 'L4' },
  { key: 'k5', label: 'L5' },
  { key: 'k6', label: 'L6' },
  { key: 'k7', label: 'L7' },
  { key: 'k8', label: 'L8' },
  { key: 'k9', label: 'L9' },
  { key: 'k10', label: 'L10' },
  { key: 'k11', label: 'L11' },
  { key: 'k12', label: 'L12' },
  { key: 'k13', label: 'L13' },
  { key: 'k14', label: 'L14' },
  { key: 'k15', label: 'L15' },
  { key: 'k16', label: 'L16' },
  { key: 'k17', label: 'L17' },
  { key: 'k18', label: 'L18' },
  { key: 'k19', label: 'L19' },
  { key: 'k20', label: 'L20' },
  { key: 'k21', label: 'L21' },
  { key: 'k22', label: 'L22' },
  { key: 'k23', label: 'L23' },
  { key: 'k24', label: 'L24' },
  { key: 'k25', label: 'L25' },
  { key: 'k26', label: 'L26' },
  { key: 'k27', label: 'L27' },
  { key: 'k28', label: 'L28' },
  { key: 'k29', label: 'L29' },
  { key: 'k30', label: 'L30' },
  { key: 'k31', label: 'L31' },
  { key: 'k32', label: 'L32' },
  { key: 'k33', label: 'L33' },
  { key: 'k34', label: 'L34' },
  { key: 'k35', label: 'L35' },
]

export function Side() {
  const s = useStore(sel)
  return (
    <nav>
      {ITEMS.map((it) => (
        <a
          key={it.label}
          data-testid={`row-${it.key}`}
          className={s.active === it.key ? 'on' : 'off'}
        >
          <Icon k={it.key} />
          <span>{it.label}</span>
        </a>
      ))}
    </nav>
  )
}
