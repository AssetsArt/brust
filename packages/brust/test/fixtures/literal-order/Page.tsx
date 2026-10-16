import Table from './Table'

// F333: object literals written out of sorted order, read with Object.entries / Object.keys by a native child.
export default function Page() {
  return (
    <main>
      <Table id="words" cfg={{ z: 'zz', a: 'aa', m: 'mm' }} />
      <Table id="nums" cfg={{ 10: 'ten', 2: 'two', b: 'bee', a: 'ay' }} />
    </main>
  )
}
