import { Fallback, Sep } from '@/components/ui/sep'
import { Spinner } from '@/components/ui/spinner'

export default function Page() {
  return (
    <main>
      <ul>
        <Sep />
      </ul>
      <Fallback />
      <Fallback label="given" />
      <Fallback label="" />
      <Spinner />
      <Spinner aria-label="Saving" data-x="1" />
    </main>
  )
}
