export default function Deep({ cfg }: { cfg: { label: { text: string }; tags: string[] } }) {
  return <i data-testid="deep">{`${cfg.label.text}:${cfg.tags.join(',')}`}</i>
}
