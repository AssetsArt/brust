// Prints something else and hangs: startApp must time out and kill it.
console.log('[fake] booting, no listening line will ever come')
await new Promise(() => {})
export {}
