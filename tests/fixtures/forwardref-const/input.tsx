import * as React from 'react'
import Wrapped from './Wrapped'
import { Label, Input } from './parts'

export default function Form({ id }: { id: string }) {
  return (
    <form>
      <Label htmlFor={id}>Name</Label>
      <Input id={id} />
      <Wrapped title="x" />
    </form>
  )
}
