// NATIVE behavior — the topbar search trigger. Opens the React SearchPalette island
// by dispatching the `brust:open-search` event it listens for. react-free. Token
// styling via .b-search / .b-kbd classes (native components avoid inline styles).
import { Search } from 'lucide-react'

export const behavior = () => {
  const open = () => window.dispatchEvent(new CustomEvent('brust:open-search'))
  return { open }
}

export default function SearchTrigger() {
  return (
    <button type="button" x-on-click="open" aria-label="Search docs" className="b-search">
      <Search size={16} />
      <span>Search docs…</span>
      <span className="ml-auto flex items-center gap-1">
        <kbd className="b-kbd">⌘</kbd>
        <kbd className="b-kbd">K</kbd>
      </span>
    </button>
  )
}
