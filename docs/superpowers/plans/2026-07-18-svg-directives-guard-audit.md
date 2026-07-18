# SVG directive runtime guard audit

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 · authority: in-loop

## Goal

Audit every `HTMLElement` assumption in `runtime/native/runtime.ts` and recommend the smallest coherent `Element` boundary that supports SVG directives without weakening component ownership, shadow-root handling, form-only behavior, keyed reconciliation, or disposal.

## Questions to settle

- Which guards are traversal bugs versus intentional HTML-only component-root or form-control constraints?
- Which functions can safely accept `Element`, and which require narrower element types?
- Do `x-if` and `x-for` on SVG nodes work if their element types are widened, or do cloning/keying paths contain HTML-only APIs?
- Must MutationObserver added/removed-node guards widen to `Element` to mount/dispose nested `x-data` and open shadow roots when the mutation root is SVG?
- What is the correct `setBound('class')` behavior for HTML, SVG, and MathML?
- Does changing `BehaviorCtx.el` create an avoidable public TypeScript compatibility break?

## Work

Read-only audit. Do not edit files. Cite exact paths and lines, list each `instanceof HTMLElement`, and classify it as widen/retain/refactor with API evidence. Include a proposed function-signature map and the minimal regression suite beyond the three acceptance tests.

## Output

Record the evidence as a task note prefixed `READY`, including any challenge to the stated goal. The lead owns the final ruling.

