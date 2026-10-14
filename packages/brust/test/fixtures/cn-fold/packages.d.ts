// Types of the stand-in packages in `pkgs/` (installed into `app/node_modules` by the test only).
declare module 'cn' {
  export function cn(...inputs: unknown[]): string
}
declare module 'class-variance-authority' {
  export function cva(base: string, config?: Record<string, unknown>): (props?: Record<string, unknown>) => string
}
declare module 'radix-ui' {
  export const marker: string
}
declare module 'tones' {
  export const tone: string
}
