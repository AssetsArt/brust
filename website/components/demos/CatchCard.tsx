// Demo, native tier: two useState, a controlled checkbox, a ternary src. The compiler turns the state into signals;
// the log beside the card lists each signal write as it happens.
import { useState } from 'react'

export default function CatchCard({ no, name, type, art, shinyArt }: { no: string; name: string; type: string; art: string; shinyArt: string }) {
  const [caught, setCaught] = useState(0)
  const [shiny, setShiny] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [writes, setWrites] = useState(0)
  return (
    <div className="nvp">
      <article className="catch">
        <div className="art">
          <img src={shiny ? shinyArt : art} alt={name} width={200} height={200} />
        </div>
        <div className="cmeta">
          <span className="no">{no}</span>
          <h4>{name}</h4>
          <span className={`ty ${type}`}>{type}</span>
        </div>
        <div className="controls">
          <label className="sw">
            <input
              type="checkbox"
              checked={shiny}
              onChange={(e) => {
                setShiny(e.target.checked)
                setLog([`${writes + 1}. shiny = ${e.target.checked}`, ...log].slice(0, 5))
                setWrites(writes + 1)
              }}
            />
            <span className="knob" aria-hidden="true" />
            Shiny
          </label>
          <button
            type="button"
            className="demo-btn"
            onClick={() => {
              setCaught(caught + 1)
              setLog([`${writes + 1}. caught = ${caught + 1}`, ...log].slice(0, 5))
              setWrites(writes + 1)
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
          {log.map((l) => (
            <li key={l}>
              <b>{l}</b>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
