import { DirectionProvider } from '../components/ui/direction'

export default function Page() {
  return (
    <DirectionProvider direction="rtl">
      <p dir="rtl">مرحبا</p>
    </DirectionProvider>
  )
}
