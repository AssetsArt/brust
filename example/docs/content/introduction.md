---
title: Introduction
description: Install brust and render your first native route.
nav: { group: "Getting Started", order: 1 }
---

brust apps start from a single `routes.tsx`: every route is a JSX component,
and routes marked `native: true` compile ahead of time to templates the Rust
server renders without React. This page will walk through scaffolding a
project and shipping a first page. Full content lands with the guide rewrite.

## Install

Scaffold a project with `bun create brustjs`, then `brust build` compiles your
routes and `bun run dev` boots the server.
