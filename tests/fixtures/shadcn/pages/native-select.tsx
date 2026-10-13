import { NativeSelect, NativeSelectOption } from '../components/ui/native-select'

export default function Page() {
  return (
    <NativeSelect>
      <NativeSelectOption value="">Select status</NativeSelectOption>
      <NativeSelectOption value="todo">Todo</NativeSelectOption>
      <NativeSelectOption value="done">Done</NativeSelectOption>
    </NativeSelect>
  )
}
