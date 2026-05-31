export default function AdminUserThrow({ crash }: { crash?: boolean }) {
  if (crash) {
    throw new Error('intentional admin child throw — exercises parent errorBoundary')
  }
  return <div>No crash</div>
}
