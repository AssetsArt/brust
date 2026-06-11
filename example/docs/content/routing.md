---
title: Routing
description: Nested routes, layouts, and loaders in brust.
nav: { group: "Concepts", order: 1 }
---

Routes are declared as a tree passed to `defineRoutes`. Parents with
`children` become layouts that render an `<Outlet/>`; loaders run top-down
along the matched chain and merge into one context. Full content lands with
the concepts rewrite.

## Loaders

Each route may declare an async `loader`; native templates receive the merged
loader data as plain fields, so anything the template binds is precomputed.
