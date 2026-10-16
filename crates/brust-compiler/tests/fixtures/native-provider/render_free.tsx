import { RG, RT } from './Rend'
export default function P({ title }: { title: string }) { return <main><RG render={({ on }) => (<><RT>{title}</RT>{on && <p>on</p>}</>)} /></main> }
