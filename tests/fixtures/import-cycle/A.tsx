import Tree from './input'

export default function Branch({ depth }: { depth: number }) {
  return <p>{depth > 0 ? <Tree depth={depth - 1} /> : 'leaf'}</p>
}
