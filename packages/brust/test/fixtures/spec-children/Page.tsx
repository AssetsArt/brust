import { Root } from './Root'

// F324: the JSX child of a state Provider component that spreads its ...rest onto an element must reach the element.
export default function Page() {
  return <main><Root><span>hello</span></Root></main>
}
