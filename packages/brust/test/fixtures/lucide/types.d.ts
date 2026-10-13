// Types the fixture and its test need that the packages do not ship.
declare module 'react-dom/server' {
  export function renderToStaticMarkup(el: unknown): string
}
declare module 'lucide-react/dist/esm/icons/star.mjs' {
  const Star: import('lucide-react').LucideIcon
  export default Star
}
