import { RF, RT } from './Rend'
export default function P() { return <main><RF render={({ inForm }) => (<><RT>go</RT>{inForm && <p>free</p>}</>)} /></main> }
