const NAME = 'brust'
const GREETING = `hello ${NAME}`
const HOSTILE = '</script><!-- x -->\nline'

export default function Page() {
  return (
    <p title={GREETING}>
      {GREETING} {HOSTILE}
    </p>
  )
}
