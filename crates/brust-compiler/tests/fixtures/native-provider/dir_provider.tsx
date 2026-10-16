import { DirBox } from './DirBox'
import { DirectionProvider } from './dirmod'
export default function P() {
  return (
    <main>
      <DirectionProvider dir="rtl">
        <DirBox />
        <DirBox dir="ltr" />
      </DirectionProvider>
    </main>
  )
}
