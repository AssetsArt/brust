# shadcn S1 — lane `cn-fold` (F149; draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Dew · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: F149

Author: Dew. Status: **RULED 2026-10-14 (see §9); lane may start.** Base: origin/main de1ae0dd (after #218 package-source and #219 props-pattern-fix). R-numbers R34.88–R34.95 (the lead assigned R34.88 onward; R34.83–87 are spread-fed).

Sources:
- `docs/shadcn-coverage.json` @de1ae0dd: 64 measured rows; 61 static, 1 native, 2 react; 50 islands; 18 pages with no client JS.
- The JSON has no job or worker data. So a read-only scan of the same 64 pages ran `compileAsBuild` (`scripts/shadcn/app.ts`, i.e. `compileTree` plus the F153c package-source recompile) with the napi addon built at de1ae0dd. That was an incremental release build in a detached worktree, announced on `host:build-slots:dew`, and it ran no `brust build`. It counts:
  - each page's fed instances, their inputs and their job imports;
  - each page's components with `needs_worker`.
- Scripts: scratchpad `f149/measure3.ts` and `f149/wk.ts`. The lane adds the same count to the generator (R34.94).

Depends on: nothing open. It builds on:
- the constant folder (`ir/fold.rs`, R34.49, #209);
- L2 build evaluation (`analyze/passes/build_eval.rs`, `packages/brust/src/build/build-eval.ts`, `build/index.ts:266`);
- row-invariant instances (#206).

## 1. What happens today

shadcn class composition is a **per-request precompute job**. Example, Badge (the job module, as `compileAsBuild` prints it at de1ae0dd):

```ts
import { cva } from "class-variance-authority"
import { cn } from "cn"
const badgeVariants = cva("inline-flex … [&>svg]:size-3", { variants: { variant: { default: "…", secondary: "…", … } }, defaultVariants: { variant: "default" } });
export const inputs = ["className", "variant"] as const
export function precompute(props: any) {
  const { className } = props
  const variant = props.variant ?? ("default")
  return { _s1: cn(badgeVariants({ variant }), className) }
}
```

- `cn` 0.4.0 is shadcn's drop-in for `twMerge(clsx(…))`: a conflict engine with tables, 45.4 KB raw / 14.2 KB gzip (measured in the alpha.7 draft).
- `class-variance-authority` is 3.0 KB raw / 1.0 KB gzip.

Each inlined instance is a fed `InstanceRecord`, for example `<Badge variant="secondary">` → `literals: {variant: "secondary"}, exprs: {className: "__undefined"}`.

What that costs:
- `tier.rs:121` sets `needs_worker = !jobs.is_empty()`.
- Per request, brust-core calls the worker once per instance, cached by inputs.
- The HTML never changes, but serving it **needs the worker** (Bun, or the Workers isolate on Cloudflare).
- The job bundle carries `cn` and `cva` server-side.

Why the existing machinery does not catch it:
- The **constant folder** (`RawExpr::fold`, `FoldEnv::new(&lookup)` at `children.rs:1856`) already reduces the call-site inputs and the `cva` config to JSON. But it never calls a function: `cn`/`cva` are package code.
- **L2** evaluates a slot at build only when the slot has no inputs AND imports no package (`build_eval.rs:1-5`). A shadcn slot fails both rules.

## 2. Measured rows (de1ae0dd, all 64 pages)

| Count | Value |
|---|---|
| Pages with at least one worker-run component (`needs_worker`) today | **64 of 64** |
| Fed instances (a static/native child with a precompute job), all pages | **112**, on 27 pages |
| …every job input constant (a literal, or omitted = `undefined`) | **112** (51 carry at least one literal; 0 read `__props`, a row, a store value or `useId`) |
| …static (`loops: []`) | **112** (0 per-row, 0 `per-row-literal`) |
| …job imports only `cn` | 76 |
| …job imports only `cn` + `class-variance-authority` | 34 |
| …job imports `cn` + `./button` (`buttonVariants`; pagination `PaginationLink` ×2) | 2 |
| Distinct `(child, inputs)` pairs, i.e. evaluations needed | 97 (table: 14 instances → 10) |
| **Pages whose only worker need is these class jobs** | **18** |

The 18 pages, with job calls per request today (83 in total, all for markup that never changes):

| Page | Calls | Page | Calls | Page | Calls |
|---|---|---|---|---|---|
| alert | 6 | button-aschild | 1 | label | 2 |
| attachment | 6 | card | 9 | marker | 2 |
| badge | 4 | empty | 7 | message | 1 |
| badge-aslink | 1 | input | 3 | skeleton | 3 |
| bubble | 5 | item | 6 | table | 14 |
| button | 9 | kbd | 3 | textarea | 1 |

The other 9 pages with fed instances lose their class jobs (29 instances) but **keep the worker** for something else:

| Page | Instances | What keeps the worker |
|---|---|---|
| native-select | 4 | `chevronDownIcon`, a React SSR component with no client JS; F159 icon-shapes may make it static SVG, which would flip this page as well |
| breadcrumb | 7 | islands |
| field | 5 | islands |
| pagination | 5 | islands |
| button-group | 3 | islands |
| input-group | 2 | islands |
| checkbox | 1 | islands |
| sonner | 1 | islands |
| switch | 1 | islands |

Two instances (native-select, pagination's ellipsis) carry a `__store` prop. It is the passthrough for a nested island, not a job input. The jobs' `inputs` are only `className`.

## 3. Design (recommended): the folder proves, the build runs the real package once

Principle (north star, docs/plans/2026-10-14-react-parity-north-star.md: compile libs, never port): **the constant folder proves that the inputs and the configs are constant and that the code is allowed; the build then runs the same `cn`/`cva` bytes the worker would load, once, in L2's sandbox.**

- Parity with the per-request job holds by construction, not by a port.
- The folder never runs user or package code. That stays true.

### 3.1 Constant inputs: reuse `RawExpr::fold` at the call site (R34.88)

An inlined fed instance is a **candidate** when:
- every root of its child's job `inputs` is one of:
  - a literal;
  - an omitted prop (`undefined`, as F138f binds it);
  - an expression the folder reduces to JSON under the **parent module's const environment**. This is the same `FoldEnv::new(&lookup)` constant-slots uses (`children.rs:1856`). Examples:
    - `const v = "outline"; <Badge variant={v}/>`
    - `<Button size={compact ? "sm" : "default"}/>` with `compact` a module const.
- `loops` is empty.
- The child has no `useId` cells.
- No job input is a store or state value.

Change:
- `InstanceRecord.literals` is filled through that environment.
- Today it uses `json_literal` (fold with `FoldEnv::empty()`, `fold.rs:140`), so `variant={v}` lands in `exprs`.
- The fixture needs none of this: all 112 instances are already literal or omitted. It is the cheap generalisation the folder gives for free.

### 3.2 Allowed code: a classifier that runs nothing (R34.89)

The child's precompute job qualifies when every name its outputs read is one of:

1. **A job input.** It is constant by §3.1.
2. **An allowlisted import.** An import from an **allowlisted package**, by exact package name: `cn`, `clsx`, `tailwind-merge`, `class-variance-authority`.
3. **A foldable module const.** A const whose initializer the folder reduces to:
   - JSON, or
   - a call of an allowlisted import whose arguments fold to JSON, e.g. `const badgeVariants = cva("…", {variants…})`.

   The const may live in the child's module or in an **imported relative module**. Example: `buttonVariants` from `./button`, whose module also imports `radix-ui`. The eval module re-emits the folded initializer (`const buttonVariants = cva(<folded JSON>)`) and does not import `./button`, so the build never loads `radix-ui`.
4. **A pure relative helper.** An imported function from a relative module that `module_is_pure` accepts and whose own imports are only allowlisted packages. This is the classic shadcn `lib/utils.ts`: `export function cn(...i) { return twMerge(clsx(i)) }`. That module is bundled whole. With F159's tsconfig `paths` in, `@/lib/utils` resolves to it (§4, Q5).

L2's v1 rules apply unchanged:
- the global denylist (`Date`, `Intl`, `crypto`, `performance`, `process`, `fetch`, `Bun`, `globalThis`, `import.meta`, `Math.random`);
- no module `let`/`var` capture;
- not state-dependent;
- not `async`.

Island SSR jobs (`JobKind::Ssr`) are out of scope.

The rule is not class-specific: any constant-input instance job with allowed code qualifies (Q3).

### 3.3 Evaluate once at build, recompile as literals (R34.90)

**1. Compiler output**
- `ir.build_eval_instances` gets one entry per candidate: `{ key, child_id, k, inputs, line, col }`.
- `key` is `<parent source>@<call-site offset>`. It is stable across the recompile, which `k` is not; L2 keys `source@offset` for the same reason.
- The child's `eval_ts` gains `instance(props) => ({ _s1: … })`: the job body, with §3.2 (3) consts re-emitted folded.

**2. Build (`build-eval.ts`)**

The entries join the L2 slots in the same sandboxed run:
- a Bun subprocess with `TZ=UTC`;
- `Date`, random and `fetch` denied;
- 2 s per entry, JSON only, 64 KB per value;
- bundled through the same `sourceDirPlugin` resolver as the worker's job bundle, so the same bytes run;
- identical `(child, inputs)` pairs are evaluated once (97 for 112 instances).

**3. Recompile**
- The results come back as `slot_values` keyed `<instance key>#<slot>`.
- The recompile (the existing L2 second pass, `index.ts:270`) prints each output as a literal in the parent's inlined template:
  - the slot read `__<id>_<k>._sN` disappears;
  - the instance record is dropped once all of its outputs are literal;
  - a child left with no instance needing its job emits no job;
  - `needs_worker` is false for a component with no job.
- A page whose tree has no job and no island is answered by Rust alone: **zero worker dispatches** per request.
- Note: `brust start` today spawns `cfg.workers` workers whatever the manifest says (`packages/brust/src/run.ts:138`, the loop over `cfg.workers`), and `needs_worker` (`manifest.ts:308`) is not read at serve time. So this lane removes the per-request worker calls, not the worker processes. Not spawning workers for an app with no job, loader or action is Q9.

**4. Where it runs.** Wherever L2 runs: `brust build`, `--target static`, `--target cloudflare`. `brust dev` keeps the job: no build-eval in dev, as with L2 today (Q8).

**5. Failure.** A throw, a timeout, a non-JSON value, or a value over 64 KB keeps that instance's job and logs a `build-eval` warning that names `file:line:col`, exactly like an L2 slot. It is never a build error.

### 3.4 Printing and security (R34.91)

- A folded value prints like any server literal, through the escaping the template already applies: `| e` in attributes and text, under `AutoEscape::None`. A class is data, never markup, and never a raw sink.
- Constant-slots' rule holds: a folded value is never revived as a `$x` marker.
- The build runs package code only from the four allowlisted packages, in the `buildTime` sandbox. The worker already runs the same code per request today.
- Per the security rule, any new print path gets Mellow's sign-off.

## 4. Fail-closed list (the instance keeps its per-request job, output byte-identical to today) (R34.92)

| Case | Why |
|---|---|
| A job input from props, a loader or request data (`className={props.c}`, any `exprs` over `__props`) | The value differs per request |
| A job input from state, a store, or a list row (per-row path or `per-row-literal`) | The client changes it, or it differs per row (Q4) |
| A `useId` child | Ids are per request |
| The job reads a package off the allowlist, or a relative module that is neither pure nor a foldable const | The build would run unknown code |
| `@/lib/utils` while tsconfig `paths` is not resolved (before F159 lands) | It reads as a package off the allowlist; after F159 it is rule 4 |
| A `cva` config or const the folder refuses (a function value, a block-body arrow, `undefined` in JSON…) | Folder limits; the reason names the construct |
| A denied global, `async`, or a module `let`/`var` | L2 v1 rules |
| An island SSR job (`_ssr_*`, `chevronDownIcon`) | Not class composition, and the island needs the worker anyway |
| A state-dependent output of a native child | The client needs the expression, not a value |
| An evaluation failure, or a value > 64 KB | §3.3 (5): a warning, and the job stays |

## 5. Requirements (R34.88–R34.95)

- **R34.88 Constant inputs (§3.1).** Instance literals are folded with the parent module's const environment. A static instance whose every job input folds, with no `useId` and no store/state input, is a candidate.
- **R34.89 Allowed code (§3.2).** The classifier accepts only:
  - allowlisted package imports;
  - folded module consts, own or imported, re-emitted folded;
  - pure relative helpers whose imports are allowlisted.

  It runs nothing. A refusal is an info diagnostic naming the first offending import or construct, not a fallback.
- **R34.90 Build evaluation (§3.3).** Candidates are evaluated once per distinct `(child, inputs)` in L2's sandbox and recompiled as literals. A component with no job left has `needs_worker: false`, and a page with no job and no island makes zero worker dispatches per request.
- **R34.91 Printing.** A folded value goes through the existing escaping and is never revived as a marker.
- **R34.92 Fail closed (§4).** Every row of §4 keeps today's per-request job with byte-identical output. An evaluation failure is a warning, never an error.
- **R34.93 Equality.** For every folded instance, the served HTML equals the HTML with folding off. A test-only switch disables the instance fold for the comparison.
- **R34.94 Battery and scoreboard.**
  - **Battery rows** (no `knownGap`). The battery runs `brustc` only, so the rows assert the candidate list and the refusal reason:
    - `b-cn-fold-literal`: `<Badge variant="secondary"/>`, cva + cn → candidate.
    - `b-cn-fold-omitted`: no props → candidate, inputs `undefined`.
    - `b-cn-fold-module-const`: `const v = "outline"` → candidate with `variant: "outline"`.
    - `b-cn-fold-imported-cva`: `buttonVariants` from a sibling that also imports `radix-ui` → candidate, and the eval module has no `./button` import.
    - `b-cn-fold-lib-utils`: classic relative `lib/utils.ts` (clsx + tailwind-merge) → candidate.
    - `b-cn-fold-pure-helper`: `label(tone)` from a pure relative module → candidate (Q3).
    - `b-cn-fold-prop-input`: `variant={props.v}` → job stays.
    - `b-cn-fold-other-package`: a non-allowlisted package → job stays; the reason names it.
    - `b-cn-fold-useid` → job stays.
    - `b-cn-fold-row-reading`: `per-row-literal` → job stays (Q4).
    - `b-cn-fold-denied-global`: a config reading `Date` → job stays; the reason names `Date`.
  - **Scoreboard.** `docs/shadcn-coverage.{md,json}` gains a per-row **`worker`** column (`needs_worker` over the page tree: does a request dispatch to the worker; Q6) and a summary `pagesWithNoWorker`. Predicted:

    | | Before | After |
    |---|---|---|
    | `pagesWithNoWorker` | 0 | 18 |
    | Fed instances | 112 | 0 |

    Tiers, islands and client JS are unchanged. The generator is run twice and the output must be identical.
- **R34.95 Proof.**
  - **Started servers.** badge, button, card, table and label are built and **started** (`brust start`, the S1.3 lesson). For each:
    - the served HTML equals React's `renderToStaticMarkup` with the real `cn`/`cva`;
    - a request for the page makes **zero worker dispatches**, asserted on the dispatch counter (the devtools trace or the napi dispatch count), not on the manifest.
  - **R34.93 equality test** over all 27 pages with fed instances, fold on vs fold off.
  - **Bytes.** Server bundle bytes before and after for the 18 pages, in the PR.

Ledger rows, not in this lane:
- per-row fold (Q4);
- a user-declared pure-package list (Q2);
- dev-mode folding (Q8).

## 6. Risks

1. **Package code at build.** The build now runs the four allowlisted packages. Mitigations:
   - the L2 sandbox: denied nondeterminism, a timeout, JSON only;
   - exact-name allowlisting;
   - the worker already runs the same code per request, so a malicious `cn` already runs today.

   The PR says so.
2. **Same bytes.** Parity depends on the eval bundle resolving the same `cn`/`cva` files as the job bundle. Both go through `sourceDirPlugin`, and the F155 resolve rules apply alike. R34.93 is the guard.
3. **Re-emitted consts.** A folded `cva(...)` config must print with the same JS meaning (key order, numbers). The folder refuses what it cannot print exactly: `V::to_json` refuses `undefined`, so such a config keeps its job.
4. **Build time.** 97 deduplicated evaluations in one subprocess cost milliseconds. The recompile is L2's existing second pass.
5. **Shared files.** `children.rs`, `build_eval.rs`, `lower/{server,template}.rs` and `build/index.ts` are also touched by spread-fed (R34.83–87) and icon-shapes (F159). Readiness-order merges apply, and the lane merges main before READY.

## 7. Boundary and gates

**Boundary.**
- `crates/brust-compiler/src/analyze/passes/{children,build_eval,tier}.rs`, `ir/{decls,mod,fold}.rs`, `lower/{server,template}.rs`.
- `packages/brust/src/build/{build-eval,index,compile}.ts`.
- Tests in those crates and packages.
- `scripts/battery/**`, `docs/react-coverage.md`.
- `scripts/shadcn/**` (the worker column), `docs/shadcn-coverage.{md,json}` (regenerated), `docs/plans/m1a-followups.md` (F149).
- No brust-core change. No manifest version change: the manifest only loses records.

**Gates (targeted).**
- `cargo fmt --check` and the CI clippy line.
- `cargo test --workspace --exclude bun_react_compiler --no-fail-fast`.
- The battery and `bun test scripts/battery`.
- The `packages/brust` build-eval, build-manifest and e2e tests.
- `bun test scripts/shadcn`, plus the generator run twice with identical output.
- The started-server proof (R34.95).

Cold builds follow `host:build-slots`. Heavy runs are announced on the task first.

**Order.** One lane, two commits:
1. §3.1 + §3.2: compiler only (candidates in the IR, refusals, battery rows).
2. §3.3 + §3.4: build evaluation, recompile, scoreboard column and proof.

## 8. Questions for the lead

- **Q1 Where does the call itself get evaluated?** The brief says to reuse `RawExpr::fold`, and §3 does that for everything that is constant: call-site inputs, `cva` configs, imported consts.
  - **Recommended:** evaluate the `cn`/`cva` calls with the **real package in L2's sandbox**.
  - **Not recommended:** teaching the folder the calls. `clsx` and `cva` are small and spec-like, but `cn` is `tailwind-merge`, a conflict engine with tables that an app can configure (`extendTailwindMerge`, the `cn` build plugin). Folding it in Rust would be a port, which breaks the north star and can drift from what the islands and worker run.
  - **Not recommended:** a Rust fold of `clsx`/`cva` plus the sandbox for `cn` alone. It is two mechanisms for the same 112 instances.
- **Q2 The allowlist.**
  - **Recommended:** exactly `cn`, `clsx`, `tailwind-merge`, `class-variance-authority`, by package name.
  - A user-declared list (`[build] pure = [...]`) is a later row with its own review.
  - `sideEffects: false` is not purity and is not used.
- **Q3 Class-only, or any constant-input instance job?**
  - **Recommended:** any, under the same allowed-code rule. Class-only would be name-matching.
- **Q4 Per-row instances (`per-row-literal`)?**
  - **Recommended:** not in v1. 0 fixture rows need it, and it would need an indexed literal table in the template. Ledger row.
- **Q5 `@/lib/utils`.**
  - **Recommended:** no special case here. F159 (icon-shapes) adds tsconfig `paths`. Once it is in, `@/lib/utils` resolves to the relative module and rule 4 applies.
  - If F149 merges first, the `button-alias` row keeps its job until F159 lands. The battery row asserts whichever order merged.
- **Q6 Scoreboard `worker` column?**
  - **Recommended:** yes. The fold's whole effect is "no worker", and today's columns (tier, islands, JS) cannot show it.
- **Q7 Diagnostics.**
  - **Recommended:** a kept job is an **info** diagnostic with the reason, shown in the coverage "Why" column, not in the build log.
  - A `build-eval` warning is emitted only when evaluation was attempted and failed.
- **Q8 `brust dev`.**
  - **Recommended:** no fold in dev (L2 runs only in the build, `build/index.ts:266`). The page behaves identically, it just keeps its jobs. A dev fold is a later row if reload time shows it matters.
- **Q9 Worker processes.** Today every `brust start` spawns `cfg.workers` workers (`run.ts:138`).
  - **Recommended:** a separate row: skip spawning when the manifest has no job, loader, action or island SSR on any route.
  - It is app-wide (one route with a job needs the pool), and it touches start-up, drain and health. Not this lane.

## 9. Lead ruling (2026-10-14)

Accepted: the folder proves constancy and allowed code, the build runs the real package bytes once in L2's sandbox. This keeps the north star (compile libs, never port: no Rust `tailwind-merge`). Rulings on §8:

- **Q1 Real package in L2's sandbox: yes.** Mellow signs off the sandbox boundary for package code (allowlisted packages only, same denylist, no network) as a gate; the package-source G3 ("package code is never executed") is about analysis and stays true there.
- **Q2 Allowlist exactly `cn`, `clsx`, `tailwind-merge`, `class-variance-authority`**, by package name. A user-declared list is a later row.
- **Q3 Any constant-input instance job** under the allowed-code rule.
- **Q4 Per-row instances: not in v1** (ledger row).
- **Q5 No special case for `@/lib/utils`;** icon-shapes (F159) is about to land and supplies it; the battery row asserts the merged order.
- **Q6 Scoreboard `worker` column: yes.**
- **Q7 Info diagnostic with the reason; a warning only when evaluation was attempted and failed.**
- **Q8 No fold in `brust dev`.**
- **Q9 Separate row: F165** "skip spawning workers when the manifest has no job, loader, action or island SSR on any route" (start-up, drain and health are in its scope).
