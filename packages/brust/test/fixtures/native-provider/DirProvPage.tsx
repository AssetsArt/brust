import { DirBox } from './DirBox'
import { DirectionProvider } from './dirmod'
export default function DirProvPage() {
  return (
    <main>
      <DirectionProvider dir="rtl">
        <DirBox />
        <DirBox dir="ltr" />
      </DirectionProvider>
    </main>
  )
}
