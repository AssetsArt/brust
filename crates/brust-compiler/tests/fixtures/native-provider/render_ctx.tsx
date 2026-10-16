import { RC, RT } from './Rend'
export default function P() { return <main><RC render={({ on }) => (<><RT>go</RT>{on && <p>on</p>}</>)} /></main> }
