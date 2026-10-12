// cf-min's entry inputs for lane 4's `cfEntrySource` (ruling D3): fixture-relative paths, the e2e CONFIG.
export const CF_MIN_ENTRY_INPUT = {
  entry: '../routes.tsx',
  jobsEntry: '../dist/jobs.js',
  actionsEntry: '../actions.ts',
  prefix: '/_brust/action',
  manifestPath: '../dist/manifest.json',
  templatesPath: '../dist/cf/templates.json',
  config: {
    abi: 1 as const,
    generator: 'brust/cf-e2e',
    l1Capacity: 256,
    jobCacheCapacity: 512,
    stats: true,
    edgeCache: 'off' as const,
    cors: { origins: ['https://ok.example'], credentials: false },
    actions: { prefix: '/_brust/action', maxBodyBytes: 1024, maxResponseBytes: 8388608, crossSite: 'reject' as const },
  },
}
