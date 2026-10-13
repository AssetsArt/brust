// The tier tabs (native): the selected tab, the sliding underline, and the panels below (shown/hidden by id; a new panel rises and its pipe sends a dot).
import { useEffect, useState } from 'react'

function choose(name: string) {
  for (const t of ['static', 'native', 'react']) {
    const panel = document.getElementById('p-' + t)
    if (panel) panel.hidden = t !== name
  }
  const panel = document.getElementById('p-' + name)
  const pipe = panel ? panel.querySelector('[data-pipe]') : null
  if (panel && pipe) {
    panel.classList.remove('enter')
    pipe.classList.remove('go')
    void panel.offsetWidth
    panel.classList.add('enter')
    pipe.classList.add('go')
  }
  place(name)
}

function place(name: string) {
  const tab = document.getElementById('tab-' + name)
  const ink = document.getElementById('tab-ink')
  if (tab && ink) {
    ink.style.setProperty('--ink-x', tab.offsetLeft + 'px')
    ink.style.setProperty('--ink-s', String(tab.offsetWidth / 100))
  }
}

export default function TierTabs() {
  const [sel, setSel] = useState('static')
  useEffect(() => {
    place('static')
    const onResize = () => {
      const on = document.querySelector('#tabs [aria-selected="true"]')
      if (on) place(on.id.slice(4))
    }
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])
  return (
    <div className="relative flex gap-0 overflow-x-auto border-b border-rule" role="tablist" id="tabs">
      <button
        type="button"
        role="tab"
        className="grid cursor-pointer gap-[.1rem] rounded-xs border-0 bg-transparent px-5 py-[.8rem] text-left whitespace-nowrap text-ink-2 [font:inherit] aria-selected:text-ink"
        id="tab-static"
        aria-selected={sel === 'static'}
        aria-controls="p-static"
        onClick={() => {
          setSel('static')
          choose('static')
        }}
      >
        <b className="text-[15px] font-semibold text-ink">
          <span className="inline-flex items-center gap-[.35rem] font-mono text-[12px] before:size-2 before:rounded-xs before:content-[''] text-t-static before:bg-t-static">static</span>
        </b>
        <span className="text-[13px]">Reads props, renders markup</span>
      </button>
      <button
        type="button"
        role="tab"
        className="grid cursor-pointer gap-[.1rem] rounded-xs border-0 bg-transparent px-5 py-[.8rem] text-left whitespace-nowrap text-ink-2 [font:inherit] aria-selected:text-ink"
        id="tab-native"
        aria-selected={sel === 'native'}
        aria-controls="p-native"
        onClick={() => {
          setSel('native')
          choose('native')
        }}
      >
        <b className="text-[15px] font-semibold text-ink">
          <span className="inline-flex items-center gap-[.35rem] font-mono text-[12px] before:size-2 before:rounded-xs before:content-[''] text-t-native before:bg-t-native">native</span>
        </b>
        <span className="text-[13px]">Local state and handlers</span>
      </button>
      <button
        type="button"
        role="tab"
        className="grid cursor-pointer gap-[.1rem] rounded-xs border-0 bg-transparent px-5 py-[.8rem] text-left whitespace-nowrap text-ink-2 [font:inherit] aria-selected:text-ink"
        id="tab-react"
        aria-selected={sel === 'react'}
        aria-controls="p-react"
        onClick={() => {
          setSel('react')
          choose('react')
        }}
      >
        <b className="text-[15px] font-semibold text-ink">
          <span className="inline-flex items-center gap-[.35rem] font-mono text-[12px] before:size-2 before:rounded-xs before:content-[''] text-t-react before:bg-t-react">react</span>
        </b>
        <span className="text-[13px]">Needs the real thing</span>
      </button>
      <span className="absolute -bottom-px left-0 h-[3px] w-[100px] origin-[0_0] bg-amber [transform:translateX(var(--ink-x,0))_scaleX(var(--ink-s,0))] motion-safe:[transition:transform_.4s_var(--ease)]" id="tab-ink" />
    </div>
  )
}
