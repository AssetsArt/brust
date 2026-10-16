import { RK, RT } from './Rend'
export default function P() { return <main><RK render={({ on }) => (<><RT>go</RT>{on && <p>on</p>}</>)} /></main> }
