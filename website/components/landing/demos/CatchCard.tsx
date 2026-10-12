import { useState } from 'react'

export default function CatchCard({ no, name, art, shinyArt }: { no: string; name: string; art: string; shinyArt: string }) {
  const [caught, setCaught] = useState(0)
  const [shiny, setShiny] = useState(false)
  const [log, setLog] = useState<{ id: number; name: string; from: string; to: string }[]>([])
  const [wiggle, setWiggle] = useState(false)
  return (
    <div className="vp nvp">
      <article className="catch">
        <div className="art">
          <img className={wiggle ? 'wiggle' : undefined} src={shiny ? shinyArt : art} alt={shiny ? 'Shiny ' + name : name} width="200" height="200" />
        </div>
        <div className="cmeta">
          <span className="no">{no}</span>
          <h4>{name}</h4>
          <span className="ty electric">electric</span>
        </div>
        <div className="controls">
          <label className="sw" htmlFor="cc-shiny">
            <input
              type="checkbox"
              id="cc-shiny"
              checked={shiny}
              onChange={() => {
                setLog([{ id: Date.now(), name: 'shiny', from: String(shiny), to: String(!shiny) }, ...log].slice(0, 6))
                setShiny(!shiny)
              }}
            />
            <span className="knob" aria-hidden="true" />
            Shiny
          </label>
          <button
            type="button"
            className="demo-btn"
            onClick={() => {
              setLog([{ id: Date.now(), name: 'caught', from: String(caught), to: String(caught + 1) }, ...log].slice(0, 6))
              setCaught(caught + 1)
              setWiggle(true)
              setTimeout(() => setWiggle(false), 450)
            }}
          >
            Catch · <span>{caught}</span>
          </button>
        </div>
      </article>
      <div className="sig">
        <div className="sig-h">
          <span>Signals</span>
          <span>no re-render</span>
        </div>
        <ol aria-live="polite">
          {log.length === 0 ? <li className="hint">Use the switch or the button.</li> : null}
          {log.map((e) => (
            <li key={e.id} className="new">
              <b>{e.name}</b>
              <span>
                {e.from} → <em>{e.to}</em>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
