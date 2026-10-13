// The hero: the headline, the dusk poster with the playable build button, the two calls to action, and the tmux session.
import Button from '../Button'
import Poster from './Poster'
import TmuxSession from './TmuxSession'

export default function Hero({ version }: { version: string }) {
  return (
    <section id="hero">
      <div className="mx-auto grid max-w-[1160px] grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-end gap-10 px-4 pt-14 pb-10 max-wide:grid-cols-1">
        <h1 className="text-[clamp(3rem,6.8vw,5.9rem)] leading-[.96] font-light tracking-[0] uppercase motion-safe:animate-mirai-reveal" style={{ '--d': '0s' }}>
          React you write.
          <br />
          Rust that serves it.
        </h1>
        <div className="grid min-w-0 justify-items-end gap-[1.4rem] max-wide:justify-items-start">
          <Poster />
          <div className="flex flex-wrap gap-3 motion-safe:animate-mirai-reveal" style={{ '--d': '.3s' }}>
            <Button href="/docs/quickstart" label="Get started" primary />
            <Button href="https://github.com/AssetsArt/brust" label="Star on GitHub" />
          </div>
        </div>
      </div>
      <TmuxSession version={version} />
    </section>
  )
}
