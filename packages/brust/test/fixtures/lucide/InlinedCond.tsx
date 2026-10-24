// F407 (Assets Art B-7): a static component with an icon, under a condition, inside a static component that holds an
// icon of its own, all inlined into the page. The first compile sees both icons as islands (jobs); the build's second
// compile renders them to SVG, so neither component has a job and the page builds.
import { ArrowRight, Hand } from 'lucide-react'

type Post = { href: string; interactive: boolean }

function TryBadge() {
  return (
    <span className="badge">
      <Hand className="size-3.5" />
      try
    </span>
  )
}

function Featured({ post }: { post: Post }) {
  return (
    <a href={post.href}>
      {post.interactive && <TryBadge />}
      <ArrowRight className="size-4" />
    </a>
  )
}

export default function InlinedCond({ post }: { post: Post }) {
  return (
    <main>
      <Featured post={post} />
    </main>
  )
}
