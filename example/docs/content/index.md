---
title: Overview
description: What brust is and how these docs are organized.
nav: { order: 0 }
---

brust is a native-first web framework. You write routes as JSX components;
`brust build` compiles them to templates rendered by a Rust server, and only
the components you explicitly mark as islands ship JavaScript to the browser.
The result is server-rendered HTML with a hydration budget you control line by
line.

These docs walk from installation to deployment. Start with Getting Started if
you are new, or jump to Concepts for the rendering model, stores, and actions.
Every page on this site is a markdown file rendered by brust itself — including
the live component demos embedded later in the guides.
