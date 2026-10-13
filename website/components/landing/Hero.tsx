// The hero: the headline, the dusk poster with the playable build button, the two calls to action, and the tmux session.
import Button from '../Button'
import Poster from './Poster'
import TmuxSession from './TmuxSession'

export default function Hero({ version }: { version: string }) {
  return (
    <section className="hero play" id="hero">
      <div className="wrap hero-top">
        <h1 className="rv" style={{ '--d': '0s' }}>
          React you write.
          <br />
          Rust that serves it.
        </h1>
        <div className="hero-side">
          <Poster />
          <div className="cta rv" style={{ '--d': '.3s' }}>
            <Button href="/docs/quickstart" label="Get started" primary />
            <Button href="https://github.com/AssetsArt/brust" label="Star on GitHub" />
          </div>
        </div>
      </div>
      <TmuxSession version={version} />
    </section>
  )
}
