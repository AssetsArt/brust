import Field from './Field'
export default function Form(props: { fields: { key: string; label: string }[] }) {
  return (
    <form>
      {props.fields.map((f) => (
        <Field key={f.key} label={f.label} />
      ))}
    </form>
  )
}
