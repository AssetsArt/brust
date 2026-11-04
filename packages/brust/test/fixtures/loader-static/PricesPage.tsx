import { PriceList, type Section } from './parts'

export default function PricesPage({ sections }: { sections: Section[] }) {
  return <main><PriceList sections={sections} /></main>
}
