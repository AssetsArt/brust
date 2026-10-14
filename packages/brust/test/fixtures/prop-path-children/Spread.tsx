import Frame from './Frame'

// A spread into a wrapper whose island renders {children}: the loader's data carries a __ch shaped like a tree.
export default function Spread(props: any) {
  return (
    <main>
      <Frame label="s" {...props} />
    </main>
  )
}
