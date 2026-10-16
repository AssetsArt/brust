import { RM, RT } from './Rend'
export default function P() { return <main><RM render={({ inForm }) => (<><RT>go</RT><p>{inForm}</p></>)} /></main> }
