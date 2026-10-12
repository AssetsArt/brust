// The landing sets CSS custom properties (`--d`, `--k`, `--h`…) through `style`: allow any `--*` key on React's CSSProperties.
import 'react'

declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined
  }
}
