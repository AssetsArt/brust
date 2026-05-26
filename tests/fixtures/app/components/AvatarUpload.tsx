import { useState } from 'react'
import { formAction, BrustActionError } from '../../../../runtime/client/index.ts'
import type * as srv from '../actions'

const uploadAvatar = formAction<typeof srv.uploadAvatar>('uploadAvatar')

export default function AvatarUpload() {
  const [status, setStatus] = useState<string>('Choose a file and click Upload.')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    setStatus('Uploading...')
    try {
      const result = await uploadAvatar(fd)
      setStatus(`Uploaded ${result.name} (${result.size} bytes).`)
    } catch (caught) {
      if (caught instanceof BrustActionError) {
        setStatus(`Error: status ${caught.status}: ${caught.message}`)
      } else {
        setStatus(`Error: ${caught instanceof Error ? caught.message : String(caught)}`)
      }
    }
  }

  return (
    <form onSubmit={onSubmit} encType="multipart/form-data" data-testid="avatar-form">
      <input data-testid="avatar-file" type="file" name="file" accept="image/*" />
      <button type="submit">Upload</button>
      <p data-testid="avatar-status">{status}</p>
    </form>
  )
}
