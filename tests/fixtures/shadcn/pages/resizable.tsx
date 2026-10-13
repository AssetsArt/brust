import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../components/ui/resizable'

export default function Page() {
  return (
    <ResizablePanelGroup orientation="horizontal" className="max-w-md rounded-lg border">
      <ResizablePanel defaultSize={50}>
        <div className="flex h-[200px] items-center justify-center p-6">One</div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50}>
        <div className="flex h-[200px] items-center justify-center p-6">Two</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
