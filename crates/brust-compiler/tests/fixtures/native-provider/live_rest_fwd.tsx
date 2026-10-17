import { LRoot } from './LiveRest'
// two levels: a forwarder that spreads its own rest into LRoot inherits the requirement
function W({ tone, ...rest }: { tone?: string; [k: string]: unknown }) {
  return <section data-tone={tone}><LRoot {...rest} /></section>
}
export default function P() { return <main><W tone="a" data-x="1" /></main> }
