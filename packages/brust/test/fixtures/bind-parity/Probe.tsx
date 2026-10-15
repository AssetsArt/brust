import { useState } from 'react'

// F201/F202: client-updated attributes of every boolean kind that bind.ts used to miss (it knew 8 of React's 28 names),
// and an SVG <a> whose href becomes "". `start` is the initial state; a click flips it.
export default function Probe({ start }: { start: boolean }) {
  const [on, setOn] = useState(start)
  return (
    <div>
      <button type="button" data-testid="flip" onClick={() => setOn(!on)}>
        flip
      </button>
      <div
        data-testid="bools"
        // @ts-expect-error TS reports one excess prop for the whole element; React renders every one of them
        loop={on}
        muted={on}
        inert={on}
        itemScope={on}
        allowFullScreen={on}
        autoPlay={on}
        playsInline={on}
        noValidate={on}
        readOnly={on}
        required={on}
        reversed={on}
        aria-busy={on}
        data-on={on}
        download={on}
      />
      {/* @ts-expect-error a custom element is not in the React types */}
      <x-y data-testid="ce" disabled={on} aria-busy={on} foo={on} download={on} />
      <svg width="10" height="10">
        <a data-testid="svga" href={on ? '/x' : ''}>
          <circle r="2" />
        </a>
      </svg>
    </div>
  )
}
