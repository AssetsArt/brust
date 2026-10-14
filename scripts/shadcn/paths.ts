import { join, resolve } from 'node:path'

export const repo = resolve(import.meta.dir, '../..')
export const FIXTURE = join(repo, 'tests/fixtures/shadcn')
export const REPORT = join(repo, 'docs/shadcn-coverage.md')
export const REPORT_JSON = join(repo, 'docs/shadcn-coverage.json')
