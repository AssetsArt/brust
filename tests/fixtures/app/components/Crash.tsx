export default function Crash() {
  throw new Error('intentional crash for test')
  // unreachable
}
