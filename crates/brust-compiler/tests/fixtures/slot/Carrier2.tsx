import Carrier from './Carrier'

// F369a: a carrier of a carrier
export default function Carrier2({ size = 'm', ...rest }: any) {
  return <Carrier data-size={size} {...rest} />
}
