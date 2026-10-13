const A = 'x'
const B = A + 'y'
const C = `${B}z`
const FLAGS = { on: true, label: C }

export default function Page() {
  return <p data-on={FLAGS.on ? 'yes' : 'no'}>{FLAGS.label}</p>
}
