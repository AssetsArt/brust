import { PSetter } from './SwRefuse'
export default function Page() { return <main><PSetter render={({ checked, setChecked }) => <button type="button" data-c={String(checked)} onClick={() => setChecked((c) => !c)} />} /></main> }
