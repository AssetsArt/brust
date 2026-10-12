// Bun-side stand-in (the normal build imports actions.ts under Bun); the Workers build aliases it to do.cf.ts via [cloudflare.alias].
export const stubs = async (): Promise<never> => {
  throw new Error('cf-cache fixture: the Durable Object stubs exist on Cloudflare Workers only')
}
