export default function StyleObject({ theme }: { theme: { fg: string } }) {
  return (
    <div style={{ backgroundColor: "red", width: 62, opacity: 1 }}>
      <span style={{ color: theme.fg, zIndex: 5 }}>hi</span>
    </div>
  )
}
