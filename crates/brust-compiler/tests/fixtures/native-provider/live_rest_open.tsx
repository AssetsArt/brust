import { LRoot } from './LiveRest'
// a spread of keys known only at render may carry `data-state`
function W({ o }: { o: Record<string, string> }) {
  return <LRoot {...o} />
}
export default function P() { return <main><W o={{ 'data-x': '1' }} /></main> }
