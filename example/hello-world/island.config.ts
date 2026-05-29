// Demo island map. `Counter` powers the React-path island on HelloWorld.
// `ClientCounter` / `ServerCounter` are the two native-route islands on
// NativeIslands (same component, distinct ids — the native compiler rejects
// duplicate island ids on one page).
export default {
  islands: {
    Counter: './components/Counter.tsx',
    ClientCounter: './components/Counter.tsx',
    ServerCounter: './components/Counter.tsx',
  },
}
