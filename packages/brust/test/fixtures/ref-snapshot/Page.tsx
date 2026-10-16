import Field from './Field'

export default function Page() {
  return (
    <main>
      <Field checked={true} />
      <Field checked={false} />
      <Field checked={false} defaultChecked={true} />
    </main>
  )
}
