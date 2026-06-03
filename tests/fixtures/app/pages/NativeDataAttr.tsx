import { BrustPage } from 'brustjs'
export default function NativeDataAttr({ mode }: { mode: string }) {
  return (
    <BrustPage title="data-attr" data-mode="dark" data-rev={mode}>
      <div className="x">ok</div>
    </BrustPage>
  )
}
