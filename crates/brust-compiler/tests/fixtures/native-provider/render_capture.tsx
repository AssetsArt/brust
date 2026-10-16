import { RG, RT } from './Rend'
export default function P() { return <main><RG render={({ on: shown }) => (<><RT>go</RT>{[1, 2].map((on) => (<i key={on}>{shown ? on : 0}</i>))}</>)} /></main> }
