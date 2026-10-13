// The tier tabs (native): the selected tab, the sliding underline, and the panels below (shown/hidden by id; a new panel rises and its pipe sends a dot).
import { useEffect, useState } from 'react'

function choose(name: string) {
  for (const t of ['static', 'native', 'react']) {
    const panel = document.getElementById('p-' + t)
    if (panel) panel.hidden = t !== name
  }
  const panel = document.getElementById('p-' + name)
  const pipe = panel ? panel.querySelector('.pipe') : null
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
    <div className="tabs" role="tablist" id="tabs">
      <button
        type="button"
        role="tab"
        id="tab-static"
        aria-selected={sel === 'static'}
        aria-controls="p-static"
        onClick={() => {
          setSel('static')
          choose('static')
        }}
      >
        <b>
          <span className="tier static">static</span>
        </b>
        <span className="d">Reads props, renders markup</span>
      </button>
      <button
        type="button"
        role="tab"
        id="tab-native"
        aria-selected={sel === 'native'}
        aria-controls="p-native"
        onClick={() => {
          setSel('native')
          choose('native')
        }}
      >
        <b>
          <span className="tier native">native</span>
        </b>
        <span className="d">Local state and handlers</span>
      </button>
      <button
        type="button"
        role="tab"
        id="tab-react"
        aria-selected={sel === 'react'}
        aria-controls="p-react"
        onClick={() => {
          setSel('react')
          choose('react')
        }}
      >
        <b>
          <span className="tier react">react</span>
        </b>
        <span className="d">Needs the real thing</span>
      </button>
      <span className="ink" id="tab-ink" />
    </div>
  )
}
