// An app-authored inline <style> (dangerouslySetInnerHTML): blocked by the base policy (style-src-elem 'self'), applied once
// [csp] style_src lists 'unsafe-inline'.
export default function Styled() {
  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: '#painted{color:rgb(1, 2, 3)}' }} />
      <p id="painted">painted</p>
    </main>
  )
}
