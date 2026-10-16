function Show(props: { k: string }) { return <p hidden={!['a', 'b', null, 0, true].includes(props.k as never)}>x</p> }
export default function P() { return <Show k="a" /> }
