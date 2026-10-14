// Stand-in for `class-variance-authority`: base + the chosen variant per key. `boom` reads the host environment,
// which only the build evaluator forbids: it fails at build and works per request.
export function cva(base, config = {}) {
  return (props = {}) => {
    const out = [base]
    for (const [key, options] of Object.entries(config.variants ?? {})) {
      const v = props?.[key] ?? config.defaultVariants?.[key]
      if (v === 'boom') out.push(String(process.env.BOOM ?? 'boom'))
      else if (v != null && options[v]) out.push(options[v])
    }
    return out.join(' ')
  }
}
