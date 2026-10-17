import { RCS, RT } from './Rend'
export default function Page() {
  return (
    <main>
      <RCS
        render={({ on }) => (
          <>
            <RT>go</RT>
            {on && <p data-testid="p">on</p>}
          </>
        )}
      />
    </main>
  )
}
