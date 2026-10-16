import { useEffect, useState } from 'react'
function Gate(props: { open: boolean }) {
  const [s, setS] = useState(props.open ? 'a' : 'c')
  useEffect(() => { setS(props.open ? 'a' : 'c') }, [props.open])
  return <p hidden={!['a', 'b'].includes(s)}>x</p>
}
export default function P() {
  const [open, setOpen] = useState(true)
  return <div><button type="button" onClick={() => setOpen(!open)}>t</button><Gate open={open} /></div>
}
