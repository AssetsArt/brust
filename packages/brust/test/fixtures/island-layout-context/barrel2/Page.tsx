import { useTheme } from './index'

export default function Page() {
  const v = useTheme()
  return <p data-testid="v">{v}</p>
}
