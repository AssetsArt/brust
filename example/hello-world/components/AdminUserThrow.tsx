export default function AdminUserThrow() {
  throw new Error('intentional admin child throw — exercises parent errorBoundary')
}
