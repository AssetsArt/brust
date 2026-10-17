import { QRoot } from './ScopeFwd'
// a caller that writes a literal `undefined` scope names no scope (ruling 7a25d5e0)
export default function P() { return <main><QRoot __scopeQ={undefined} /></main> }
