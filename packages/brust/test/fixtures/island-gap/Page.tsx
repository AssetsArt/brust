import Gate from './Gate'

export default function Page({ shown }: { shown: boolean }) {
  return (
    <div data-testid="row" style={{ display: 'flex', gap: '24px' }}>
      <span data-testid="a">a</span>
      <Gate shown={shown} />
      <span data-testid="b">b</span>
    </div>
  )
}
