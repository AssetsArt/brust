import { createElement } from 'react'
export const Heart = ({ size = 24, title }) =>
  createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', 'data-icon': 'heart' }, title ? createElement('title', null, title) : null, createElement('path', { d: 'M12 21l-8-8a5 5 0 017-7 5 5 0 017 7z' }))
export default Heart
