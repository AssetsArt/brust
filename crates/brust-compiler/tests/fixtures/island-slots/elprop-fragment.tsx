import { Tip } from './ui'

export default function Page() {
  return (
    <Tip
      content={
        <>
          <b>a</b>
          <i>b</i>
        </>
      }
    >
      body
    </Tip>
  )
}
