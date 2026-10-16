import { RN, RT } from './Rend'
export default function P() { return <main><RN render={({ on }) => (<><RT>go</RT>{on && <p>on</p>}</>)} /></main> }
