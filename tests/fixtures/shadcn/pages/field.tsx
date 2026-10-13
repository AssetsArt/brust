import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '../components/ui/field'
import { Input } from '../components/ui/input'

export default function Page() {
  return (
    <FieldSet className="w-full max-w-md">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input id="username" type="text" placeholder="Max Leiter" />
          <FieldDescription>Choose a unique username for your account.</FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  )
}
