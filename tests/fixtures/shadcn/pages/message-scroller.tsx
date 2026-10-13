import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '../components/ui/message-scroller'

export default function Page() {
  return (
    <MessageScrollerProvider>
      <MessageScroller className="h-64 w-80 rounded-md border">
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <MessageScrollerItem>First message</MessageScrollerItem>
            <MessageScrollerItem>Second message</MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
