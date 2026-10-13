// The closing band: the call to action and the version seal.
import Button from '../Button'

export default function Closing({ major, label }: { major: string; label: string }) {
  return (
    <section className="bg-sun text-on-amber">
      <div className="mx-auto grid max-w-[1160px] grid-cols-[1.4fr_auto_1fr] items-end gap-8 px-4 py-16 max-wide:grid-cols-1">
        <div>
          <h2 className="text-[clamp(2rem,4.5vw,3.2rem)] font-light tracking-[0] text-on-amber uppercase">Read the quickstart, then ship something small.</h2>
        </div>
        <div className="grid aspect-square w-[7.5rem] -rotate-[9deg] place-content-center rounded-full border-2 border-on-amber text-center font-mono text-[.7rem] leading-normal font-bold tracking-[.12em] text-on-amber uppercase max-wide:justify-self-start" aria-hidden="true">
          <span>brust</span>
          <b className="font-display text-[1.4rem] font-semibold tracking-[.1em]">v{major}</b>
          <span>{label}</span>
        </div>
        <div className="flex flex-wrap gap-3 [&>a]:border-on-amber [&>a]:text-on-amber [&>a:first-child]:bg-on-amber [&>a:first-child]:text-rice">
          <Button href="/docs/quickstart" label="Open the docs" primary />
          <Button href="https://github.com/AssetsArt/brust/tree/main/examples/pokedex" label="See the pokedex example" />
        </div>
      </div>
    </section>
  )
}
