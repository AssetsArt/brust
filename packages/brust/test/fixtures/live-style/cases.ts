// The style objects a native page and React both render, per state (`on`): edge values react-dom prints in its own
// way. `own`: the forwarder writes its own `style={{ color: 'red', height: 1 }}` / `className="own"` before the spread. `Page.tsx` writes the same
// expressions as literals (the compiler reads the shapes, not an array).
export type Case = { own: 'none' | 'style' | 'class'; props: Record<string, any> }
export const cases = (on: boolean): Case[] => [
  { own: 'none', props: { style: { width: on ? 5 : 0 } } },
  { own: 'none', props: { style: on ? { opacity: 0, zIndex: 0, lineHeight: 1.5 } : { opacity: 0.5, zIndex: 3, lineHeight: 2 } } },
  { own: 'none', props: { style: on ? { aspectRatio: 2, flexGrow: 0, WebkitLineClamp: 2 } : { aspectRatio: 1, flexGrow: 1, WebkitLineClamp: 3 } } },
  { own: 'none', props: { style: on ? { '--gap': '2px' } : { '--gap': 7, '--z': 0 } } },
  { own: 'none', props: { style: on ? {} : { color: 'red' } } },
  { own: 'none', props: { style: on ? { color: 'blue' } : { color: undefined, width: null } } },
  { own: 'none', props: { style: { msTransform: on ? 'scale(2)' : 'none', MozAppearance: 'none', WebkitTransform: on ? 'none' : 'scale(2)' } } },
  { own: 'none', props: { style: on ? { height: -3 } : { color: ' red ' } } },
  { own: 'none', props: { style: on ? { marginTop: 1.5, width: 10 } : { marginTop: 5, margin: 0 } } },
  { own: 'style', props: { style: on ? undefined : { width: 4 } } },
  { own: 'none', props: { style: on ? { color: true, width: false, height: 2 } : { color: 'green' } } },
  { own: 'style', props: { style: on ? { width: 7 } : { width: 4 } } },
  { own: 'none', props: { className: on ? 'on big' : 'off' } },
  { own: 'class', props: { className: on ? undefined : 'x' } },
  { own: 'none', props: { className: on ? 'a' : '' } },
]
