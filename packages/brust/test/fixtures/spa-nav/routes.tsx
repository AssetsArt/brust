// SPA navigation fixture (F454, design 2026-10-25 §7): two root layouts, nested layouts three deep, a layout whose markup
// depends on the URL through its loader (A's active link), a layout with a React island (B), two outlets the HTML parser
// breaks (P: in a `<p>`, T: in a `<table>`), a page with x-for, a React island page, two store pages, two store island
// pages, a long page with an anchor and the * route. Every layout carries a native counter, so a test can tell a kept
// layout from a replaced one.
import { defineRoutes } from '@brust/core/routes'
import A from './A'
import A2 from './A2'
import B from './B'
import Block from './Block'
import Go from './Go'
import Home from './Home'
import IslandPage from './IslandPage'
import Leaf from './Leaf'
import List from './List'
import Long from './Long'
import Mood from './Mood'
import Mood2 from './Mood2'
import NotFound from './NotFound'
import P from './P'
import R1 from './R1'
import R2 from './R2'
import StoreA from './StoreA'
import StoreB from './StoreB'
import T from './T'
import { cart } from './stores/cart'
import { late } from './stores/late'
import { mood } from './stores/mood'

export const routes = defineRoutes([
  {
    Component: R1,
    children: [
      { path: '/', Component: Home },
      { path: '/list', Component: List },
      { path: '/island', Component: IslandPage },
      { path: '/go', Component: Go },
      { path: '/store-a', Component: StoreA, loader: () => { cart.count.set(5); return {} } },
      { path: '/store-b', Component: StoreB, loader: () => { cart.count.set(5); late.v.set(7); return {} } },
      { path: '/long', Component: Long },
      // an island that reads a store, seeded 1 then 2 (F462)
      { path: '/mood-a', Component: Mood, loader: () => { mood.v.set(1); return {} } },
      { path: '/mood-b', Component: Mood2, loader: () => { mood.v.set(2); return {} } },
      // a loader that takes 500 ms: the progress bar shows (§10.2)
      { path: '/slow', Component: Leaf, loader: async () => { await new Promise((r) => setTimeout(r, 500)); return { name: 'slow' } } },
      {
        Component: A,
        loader: ({ path }) => ({ path }),
        children: [
          { path: '/a/one', Component: Leaf, loader: () => ({ name: 'a-one' }) },
          { path: '/a/two', Component: Leaf, loader: () => ({ name: 'a-two' }) },
          {
            Component: A2,
            children: [
              { path: '/a/deep/x', Component: Leaf, loader: () => ({ name: 'a-deep-x' }) },
              { path: '/a/deep/y', Component: Leaf, loader: () => ({ name: 'a-deep-y' }) },
            ],
          },
        ],
      },
      {
        Component: B,
        children: [
          { path: '/b/one', Component: Leaf, loader: () => ({ name: 'b-one' }) },
          { path: '/b/two', Component: Leaf, loader: () => ({ name: 'b-two' }) },
        ],
      },
      { Component: P, children: [{ path: '/p/x', Component: Block, loader: () => ({ name: 'p-x' }) }, { path: '/p/y', Component: Block, loader: () => ({ name: 'p-y' }) }] },
      { Component: T, children: [{ path: '/t/x', Component: Block, loader: () => ({ name: 't-x' }) }, { path: '/t/y', Component: Block, loader: () => ({ name: 't-y' }) }] },
      { path: '*', Component: NotFound },
    ],
  },
  {
    Component: R2,
    children: [
      { path: '/r2/one', Component: Leaf, loader: () => ({ name: 'r2-one' }) },
      { path: '/r2/two', Component: Leaf, loader: () => ({ name: 'r2-two' }) },
    ],
  },
])
