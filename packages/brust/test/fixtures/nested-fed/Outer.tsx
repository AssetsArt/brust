import List from './List'
export default function Outer({ children }: any) { return <List items={['a', 'b']}>{children}</List> }
