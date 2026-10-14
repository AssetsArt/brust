import { Badge } from './badge'
import { Chip } from './chip'
import { Deep } from './deep'
import { PageLink } from './link'

export default function Page() {
  return (
    <main>
      <Badge variant="secondary">a</Badge>
      <Badge>b</Badge>
      <Badge variant="boom">c</Badge>
      <PageLink href="/2">2</PageLink>
      <Chip />
      <Deep config={{}} />
    </main>
  )
}
