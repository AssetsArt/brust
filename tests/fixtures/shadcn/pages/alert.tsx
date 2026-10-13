import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'

export default function Page() {
  return (
    <div className="grid max-w-xl gap-4">
      <Alert>
        <AlertTitle>Heads up!</AlertTitle>
        <AlertDescription>You can add components to your app using the cli.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Your session has expired. Please log in again.</AlertDescription>
      </Alert>
    </div>
  )
}
