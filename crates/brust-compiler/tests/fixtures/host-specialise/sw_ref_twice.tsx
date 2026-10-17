import { PTwice } from './SwRefuse'
export default function Page() { return <main><PTwice render={({ checked }) => <b data-c={String(checked)} />} /></main> }
