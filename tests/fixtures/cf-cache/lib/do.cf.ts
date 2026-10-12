import { env } from 'cloudflare:workers'

const NS = 'cfcache'
const ns = () => (env as unknown as { BRUST_CACHE_DO: { getByName(n: string): any } }).BRUST_CACHE_DO
export const stubs = async () => ({ epoch: ns().getByName(`epoch:${NS}`), shard: (i: number) => ns().getByName(`store:${NS}:${i}`) })
