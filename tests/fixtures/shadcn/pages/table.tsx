import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'

const invoices = [
  { invoice: 'INV001', status: 'Paid', method: 'Credit Card', amount: '$250.00' },
  { invoice: 'INV002', status: 'Pending', method: 'PayPal', amount: '$150.00' },
]

export default function Page() {
  return (
    <Table>
      <TableCaption>A list of your recent invoices.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Method</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((i) => (
          <TableRow key={i.invoice}>
            <TableCell className="font-medium">{i.invoice}</TableCell>
            <TableCell>{i.status}</TableCell>
            <TableCell>{i.method}</TableCell>
            <TableCell className="text-right">{i.amount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
