// Bench island map. `Counter` backs the React-path island on `/` (HelloWorld);
// `ClientCounter` / `ServerCounter` are the two native-route islands on
// /native-islands (same component, distinct ids — the native compiler rejects
// duplicate island ids on one page). All point at the shared bench Counter.
export default {
  islands: {
    Counter: '../_shared/Counter.tsx',
    ClientCounter: '../_shared/Counter.tsx',
    ServerCounter: '../_shared/Counter.tsx',
  },
}
