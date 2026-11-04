import { PriceList } from './PriceList'
export default function PriceListPage({ data }: { data: { sections: any[] } }) {
  return <PriceList sections={data.sections} />
}
