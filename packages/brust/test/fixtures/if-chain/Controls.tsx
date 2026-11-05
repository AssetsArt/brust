import { sel } from './store'

const KEYS = ['k0', 'k3', 'k6', 'k35']

export function Controls() {
  return (
    <div>
      {KEYS.map((k) => (
        <button key={k} type="button" data-testid={`to-${k}`} onClick={() => sel.active.set(k)}>
          {k}
        </button>
      ))}
    </div>
  )
}
