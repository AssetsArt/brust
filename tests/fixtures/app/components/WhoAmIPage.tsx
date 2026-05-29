import { Island } from '../../../../runtime/index.ts'
import WhoAmI from './WhoAmI'

export default function WhoAmIPage() {
  return (
    <html>
      <head><title>Who am I</title></head>
      <body>
        <h1>Who am I?</h1>
        <Island component={WhoAmI} props={{}} hydrate="load" />
      </body>
    </html>
  )
}
