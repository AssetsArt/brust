export const fmtHeight = (dm: number) => `${(dm / 10).toFixed(1)} m`
export const fmtWeight = (hg: number) => `${(hg / 10).toFixed(1)} kg`
export const tint = (type: string) => ({ normal: '#9099a1', fire: '#ef7444', water: '#4d90d5', grass: '#63bb5b', electric: '#f5c84b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8', ground: '#d97746', flying: '#8fa8dd', psychic: '#f06fa0', bug: '#90c12c', rock: '#c7b78b', ghost: '#5269ac', dragon: '#0a6dc4', dark: '#5a5366', steel: '#5a8ea1', fairy: '#ec8fe6' } as Record<string, string>)[type] ?? '#888888'
export const label = (type: string) => type.charAt(0).toUpperCase() + type.slice(1)
