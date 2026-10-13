# North star: React as people write it, with external libraries as they ship

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · recorded 2026-10-14 from the human's words · governs: every compiler lane from P2 (shadcn/ui) on

## The goal (human, 2026-10-14)

"แผนคือจะทำจน cover React เกือบหมด ในการใช้งานส่วนใหญ่ อยากให้ความรู้สึกไม่ต่างจากการเขียน react และไม่ต้อง port libs มาเป็น brust แต่ยังใช้ได้ปกติ"

brust covers almost all of React as it is used in most apps. Writing a brust app feels no different from writing React, and libraries are used as published: nobody ports a library to brust. The compiler makes the static/native choice; the React island is the exception for what is genuinely complex, and it still works.

## What follows from it

1. **Compile, never port.** The compiler analyses the app's code and the packages it imports with the same rules (shadcn plan R34.7). No brust-specific forks or replacement implementations of libraries.
2. **Correct first, cheap second.** Anything the compiler cannot prove keeps React semantics in an island (fail closed). A component leaves the React tier only with the same HTML and the same behaviour (shadcn plan R34.3), proven by tests.
3. **No new rules for authors.** A pattern that works in React works in brust; at worst it costs an island. Diagnostics explain why a component is an island, never ask the author to rewrite valid React.
4. **Measured, not claimed.** Progress is two generated scoreboards in CI: `docs/react-coverage.md` (React API patterns, one row per pattern) and `docs/shadcn-coverage.md` (real components and the libraries under them). Every compiler lane names the rows it moves. A third scoreboard for popular libraries outside shadcn (forms, data fetching, state managers, routing helpers) follows once shadcn's is green enough to be useful.
5. **Order by data.** The next lane is the construct that blocks the most real rows (shadcn S0's ranked blocker list, then the battery's `fallback:*` counts), not the most interesting one.

## Headline today (2026-10-14, docs/react-coverage.md)

145 rows: 49 static, 38 native, 52 react, 5 error, 1 compile error. The large react buckets are hooks (`useContext`, `useReducer`, `useTransition`, `useSyncExternalStore`, `use`, …) and API surface (`createContext`, `forwardRef`, `cloneElement`, `Children.*`, `createPortal`, `lazy`/`Suspense`, `StrictMode`), plus spread props (F31) and external components. These are the expected first lanes once S0 ranks them by real usage.
