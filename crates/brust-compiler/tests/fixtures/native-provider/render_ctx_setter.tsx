import { RCS, RT } from './Rend'
export default function P() { return <main><RCS render={({ on }) => (<><RT>go</RT>{on && <p>on</p>}</>)} /></main> }
