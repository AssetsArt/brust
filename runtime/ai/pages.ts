import type { ErrorResult } from './refs.ts'

export interface PageEntry {
  path: string
  params: string[]
  catchAll: boolean
  kind: 'react' | 'native' | 'md'
  shellId: string
  title?: string
  description?: string
}

interface AiManifest {
  version: 1
  pages: PageEntry[]
}

let pagesPromise: Promise<PageEntry[] | ErrorResult> | null = null

function notFound(message: string): ErrorResult {
  return {
    ok: false,
    error: {
      code: 'not-found',
      message,
      hint: 'ai manifest not served — is the ai flag enabled?',
    },
  }
}

export function pages(): Promise<PageEntry[] | ErrorResult> {
  if (!pagesPromise) {
    pagesPromise = fetch('/_brust/ai/manifest.json', { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) return notFound(`ai manifest request failed with HTTP ${response.status}`)
        const manifest = (await response.json()) as Partial<AiManifest>
        if (manifest.version !== 1 || !Array.isArray(manifest.pages)) {
          return notFound('ai manifest has an unsupported shape')
        }
        return manifest.pages
      })
      .catch((cause) => notFound(`ai manifest request failed: ${String(cause)}`))
  }
  return pagesPromise
}

export function __resetPagesForTest(): void {
  pagesPromise = null
}
