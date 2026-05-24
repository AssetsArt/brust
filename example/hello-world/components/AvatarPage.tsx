import { Island } from '../../../runtime/index.ts'
import AvatarUpload from './AvatarUpload'

export default function AvatarPage() {
  return (
    <html>
      <head><title>Avatar Upload — Brust demo</title></head>
      <body>
        <h1>Avatar Upload</h1>
        <p>Demonstrates <code>formAction</code> posting multipart/form-data to a server action.</p>
        <Island id="AvatarUpload" component={AvatarUpload} props={{}} hydrate="load" />
      </body>
    </html>
  )
}
