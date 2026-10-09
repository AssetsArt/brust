// A worker entry that takes 20 s to import: `brust start` is still booting when the test signals it.
await Bun.sleep(20_000)
export { routes } from './routes'
