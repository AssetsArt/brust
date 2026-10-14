// Passes its children on to a component that repeats them (the repeat check must be transitive, F169).
import List from './List'
export default function Outer({ children }: any) {
  return <List items={['a', 'b']}>{children}</List>
}
