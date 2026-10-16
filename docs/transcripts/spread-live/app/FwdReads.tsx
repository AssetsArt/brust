export default function FwdReads({ style, ...props }: any) {
  return <input type="checkbox" data-s={style ? 'y' : 'n'} {...props} />
}
