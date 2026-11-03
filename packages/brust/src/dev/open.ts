// F485 P7: the command that opens `url` in the default browser (dev hotkey `o`). Argv array, no shell string.
export function openCommand(url: string, platform: string = process.platform): string[] {
  if (platform === 'darwin') return ['open', url]
  // cmd parses `&` in a URL as a separator: fine for the internal localhost URL this is called with.
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url] // the empty string is `start`'s window title slot
  return ['xdg-open', url]
}
