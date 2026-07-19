import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const LOADERS = new Map<string, 'ts' | 'tsx' | 'js' | 'jsx'>([
  ['.ts', 'ts'],
  ['.tsx', 'tsx'],
  ['.js', 'js'],
  ['.jsx', 'jsx'],
])

export async function validateChangedModules(paths: string[]): Promise<void> {
  const diagnostics: string[] = []
  for (const filePath of paths) {
    const loader = LOADERS.get(path.extname(filePath).toLowerCase())
    if (!loader || !existsSync(filePath)) continue
    const transpiler = new Bun.Transpiler({ loader, target: 'bun' })
    try {
      transpiler.transformSync(readFileSync(filePath, 'utf8'))
    } catch (error) {
      diagnostics.push(`${filePath}: ${diagnosticMessage(error)}`)
    }
  }
  if (diagnostics.length > 0) {
    throw new Error(`Invalid changed module syntax:\n${diagnostics.join('\n')}`)
  }
}

function diagnosticMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
