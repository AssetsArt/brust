// The build pipe above a tier panel: source file → brust build → the tier it compiles to. A tab switch sends a dot down it (class `go`).
export default function Pipe({ file, tier }: { file: string; tier: string }) {
  return (
    <div className="pipe">
      <span className="node">{file}</span>
      <span className="wire">
        <i style={{ '--d': '0s' }} />
      </span>
      <span className="node build">brust build</span>
      <span className="wire">
        <i style={{ '--d': '.45s' }} />
      </span>
      <span className={'tier ' + tier}>{tier}</span>
    </div>
  )
}
