import { composeEventHandlers } from '@radix-ui/primitive'
function Btn(props: any) {
  return <button type="button" {...props} />
}
export default function Page() {
  return <main><Btn onFocus={composeEventHandlers(undefined, () => { document.title = 'x' })} /></main>
}
