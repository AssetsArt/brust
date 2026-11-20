import Shell from '../components/shell/Shell'

export default function ShellPage(props: { title: string; tone: string }) {
  return (
    <main>
      <Shell title={props.title} tone={props.tone} />
    </main>
  )
}
