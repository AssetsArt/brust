import { List } from './List'
export default function ListPage({ data }: { data: { sections: any[] } }) {
  return <List sections={data.sections} />
}
