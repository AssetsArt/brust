import Field from './Field'
import Live from './Live'

export default function Page() {
  return (
    <main>
      <Field checked={true} />
      <Field checked={false} />
      <Field checked={false} defaultChecked={true} />
      <Live />
    </main>
  )
}
