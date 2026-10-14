import Cell from './Cell'
// A static wrapper with its own fed child BEFORE the slot content (Afrojack r1 F1).
export default function Kids({ tone, children }: any) { return <div><Cell tone={tone}>first</Cell>{children}<Cell tone="last">after</Cell></div> }
