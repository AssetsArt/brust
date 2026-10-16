import Field from './Field'
import Live from './Live'
import Remount from './Remount'

export default function Page() {
  return (
    <main>
      <Field checked={true} />
      <Field checked={false} />
      <Field checked={false} defaultChecked={true} />
      <Live />
      <Remount />
    </main>
  )
}
