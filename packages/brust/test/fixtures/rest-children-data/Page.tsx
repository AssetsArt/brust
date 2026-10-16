import { Outer } from './RestHlp'

// F300/F324: the JSX child of a component that hands its ...rest to a specialised Provider must reach the button.
export default function Page() {
  return <main><Outer data-x="1"><span>hello</span></Outer></main>
}
