import { List, type Section } from './parts'

export default function ListPage({ sections }: { sections: Section[] }) {
  return <main><List sections={sections} /></main>
}
