export class SerialQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((err) => {
      console.error("[brust] task in SerialQueue threw:", err)
    })
  }
}
