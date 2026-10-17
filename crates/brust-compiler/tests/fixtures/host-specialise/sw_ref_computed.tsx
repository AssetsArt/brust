import { PComputed } from './SwRefuse'
export default function Page() { return <main><PComputed render={({ checked }) => <b data-c={String(checked)} />} /></main> }
