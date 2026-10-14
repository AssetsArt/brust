import { Sep } from '@/components/ui/sep'

// `Sep` reads `children` as a value: an inlined instance that is given children cannot answer it, so this page renders
// with React (and still equals the React render).
export default function Page() {
  return (
    <main>
      <ul>
        <Sep />
        <Sep>custom</Sep>
        <Sep>{0}</Sep>
        <Sep>{''}</Sep>
      </ul>
    </main>
  )
}
