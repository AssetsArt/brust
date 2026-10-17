import Box from './Box'
// A static wrapper printing its own prop inside a native host's slot: the page links it (its prop changes).
export default function Mid({ label }: { label: string }) {
  return (
    <Box>
      <b>{label}</b>
    </Box>
  )
}
