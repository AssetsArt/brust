import { LRoot } from './LiveRest'
function W({ tone, ...rest }: { tone?: string; [k: string]: unknown }) {
  return <section data-tone={tone}><LRoot {...rest} /></section>
}
export default function P() { return <main><W tone="a" data-state="x" /></main> }
