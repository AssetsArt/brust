declare module 'tiny-fmt' {
  export function highlight(code: string, lang: string): Promise<string>
  export const table: (n: number) => Record<string, number>
}
