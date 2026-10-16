import { RH, RT } from './Rend'
export default function P() { return <main><RH render={({ on }) => (<><RT>go</RT>{on && <p>on</p>}</>)} /></main> }
