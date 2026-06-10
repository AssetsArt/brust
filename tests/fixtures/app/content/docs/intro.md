---
title: Intro
description: Islands and behaviors embedded in markdown
nav: { group: Start, order: 2 }
---

# Intro

An SSR island (server-rendered inner HTML + hydration):

<Counter start={5} label="docs" />

A client-only island (empty mount, `data-brust-csr`):

<Counter csr start={2} label="csr" />

A native behavior component (x-data host, no React):

<BehaviorBadge />

A code fence documenting the templating pipeline — the brace-bearing text below
must render LITERALLY (neutralization + anchored renumbering end-to-end):

```
{{ island_0_props }}
{% endraw %}
{% raw %}{{ not_a_real_marker }}{% endraw %}
```
