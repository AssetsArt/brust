import { Island } from '../../../../runtime/index.ts'
import NoteForm from './NoteForm'

export default function NotePage() {
  return (
    <html>
      <head><title>Note demo</title></head>
      <body>
        <h1>Create a note</h1>
        <Island id="NoteForm" component={NoteForm} props={{}} hydrate="load" />
      </body>
    </html>
  )
}
