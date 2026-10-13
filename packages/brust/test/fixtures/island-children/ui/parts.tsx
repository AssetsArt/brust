/** Static: no state, no handler. Module state is shared with the island chunk that imports it. */
export function Tag({ text }: { text: string }) {
  return <em className="tag">{text}</em>
}

export function Plain({ children }: { children?: React.ReactNode }) {
  return <p className="plain">{children}</p>
}
