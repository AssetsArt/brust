export default function Row(props: { title: string; selected: boolean; onPick: () => void }) {
  return <li className={props.selected ? 'selected' : ''} onClick={props.onPick}>{props.title}</li>
}
