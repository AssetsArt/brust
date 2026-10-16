import { RU, RT } from './Rend'
export default function P() { return <main><RU render={({ on }) => (<><RT>go</RT>{on && <p>on</p>}</>)} /></main> }
