// Types of the fixture's tsconfig `paths` aliases for the package typecheck (which does not read
// this fixture's tsconfig.json); the bundler resolves them through that tsconfig.
declare module '@db' {
  export const DB_URL: string
}
declare module '@sec' {
  export const SECRET: string
}
declare module '@ok' {
  export const GREETING: string
}
