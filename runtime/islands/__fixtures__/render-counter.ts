// Shared render counter for the ISR integration test. The CountingIsland
// fixture increments `count` each time it server-renders; the test imports this
// SAME module (Bun module cache makes it a singleton) to assert how many times
// renderToString actually ran — i.e. whether the ISR cache served a hit.
export const renderCounter = { count: 0 }
