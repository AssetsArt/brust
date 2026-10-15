import * as React from 'react'
export function useCtl({ prop, defaultProp, onChange = () => {} }: any) {
  const [value, setValue] = React.useState(defaultProp)
  const onChangeRef = React.useRef(onChange)
  React.useEffect(() => { onChangeRef.current = onChange }, [onChange])
  return [prop !== undefined ? prop : value, setValue] as const
}
