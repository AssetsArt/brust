import { api, where } from './metahelper'

function localApi(): string {
  return String(import.meta.env.API_URL ?? 'none')
}
function localDir(): string {
  return import.meta.dir
}

export default function ImportMetaPage() {
  return (
    <p>
      <span id="a">{api()}</span>
      <span id="b">{where()}</span>
      <span id="c">{localApi()}</span>
      <span id="d">{localDir()}</span>
    </p>
  )
}
