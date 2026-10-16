import { RG, RT } from './Rend'
export default function P() { return <main><RG render={({ on }) => (<><RT>go</RT>{on && <p>on</p>}</>)} /></main> }
