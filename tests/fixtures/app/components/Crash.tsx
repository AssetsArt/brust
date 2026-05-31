export default function Crash({ crash }: { crash?: boolean }) {
  throw new Error('intentional crash for test')
  return <div>No crash</div>
}
