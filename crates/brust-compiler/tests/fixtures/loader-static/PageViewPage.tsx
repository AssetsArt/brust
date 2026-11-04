import { PageView } from './PageView'
export default function PageViewPage({ data }: { data: { sections: any[] } }) {
  return <PageView sections={data.sections} />
}
