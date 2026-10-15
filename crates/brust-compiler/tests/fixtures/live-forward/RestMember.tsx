// Reads a DIFFERENT key of its rest by name: the live attribute is still the parent's to bind.
export default function RestMember({ ...rest }: any) {
  return <button {...rest}>{rest.label}</button>
}
