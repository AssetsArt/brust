import Code from './Code'
import Keyed from './Keyed'

export default function Literals() {
  return (
    <main>
      <Code code={'a\nb'} lang="ts" />
      <Code code={'c\n\nd'} lang="js" />
      <Keyed code={'k1\nk2'} />
      <Keyed code={'k3\nk4'} />
    </main>
  )
}
