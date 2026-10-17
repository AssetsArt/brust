import Panel from './Panel'

// A stateless wrapper that spreads its props into the panel (shadcn's CollapsibleContent shape).
export default function Wrap(props: { style?: Record<string, string>; children?: React.ReactNode }) {
  return <Panel {...props} />
}
