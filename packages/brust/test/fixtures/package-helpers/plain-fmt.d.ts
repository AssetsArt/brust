// The fixture package (`pkg/`) is installed only while its test runs; this declares it for the typecheck.
declare module 'plain-fmt' {
  export function tag(n: number): string
  export function loud(s: string): string
}
