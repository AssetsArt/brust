import { PNotLiteral } from './SwRefuse'
export default function Page() { return <main><PNotLiteral render={({ checked }) => <b data-c={String(checked)} />} /></main> }
