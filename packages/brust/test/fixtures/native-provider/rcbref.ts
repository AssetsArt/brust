import * as React from 'react'
import { useLayoutEffect } from './rlayout'

// Radix's `useCallbackRef` as published: the insertion effect when React has it, the layout effect when it does not
const useReactInsertionEffect = (React as any)[' useInsertionEffect '.trim().toString()]

export function useCallbackRef<T extends (...args: any[]) => any>(callback: T | undefined): T {
  const callbackRef = React.useRef<(...args: any[]) => any>(callback)
  if (typeof useReactInsertionEffect === 'function') {
    useReactInsertionEffect(() => {
      callbackRef.current = callback
    })
  } else {
    useLayoutEffect(() => {
      callbackRef.current = callback
    })
  }
  return React.useMemo(() => ((...args: any[]) => callbackRef.current?.(...args)) as T, [])
}
