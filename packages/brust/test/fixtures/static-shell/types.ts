export type Leaf = { id: string; label: string }
export type Node = { id: string; kind: 'group' | 'img' | 'text'; label: string; src?: string; children?: Leaf[] }
export type Section = { id: string; type: 'custom' | 'rule' | 'title'; title?: string; cls?: string; nodes?: Node[] }
