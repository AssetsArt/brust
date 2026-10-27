# brust patch over oven-sh/bun src/react_compiler @ 38afee6c84fcf48c0edb2466aa4b27d287a59c30 (bun-v1.4.4)

Purpose: let an external crate run lowering + HIR passes and read the reactive
function and scopes without codegen (spec §10.3). No brust logic lives here.

Changes (re-apply on every rev bump; also regenerate with scripts/bun-codegen.ts):
1. Cargo.toml: `bun_ast = { path = "../ast" }` → `bun_ast.workspace = true`
2. lib.rs: `mod imports;` → `pub mod imports;`, `pub(crate) mod pipeline;` → `pub mod pipeline;`
3. imports.rs: `ProgramContext`, `ProgramContext::new`, `init_from_scope` → `pub`
4. lowering/mod.rs: re-export `FunctionNode` and `lower` as `pub`
5. lowering/hir_builder.rs: `enum FunctionNode` → `pub`
6. lowering/build_hir/mod.rs: `fn lower` → `pub`
7. pipeline.rs: append `pub fn analyze_fn(...)` (see end of file)

Verify with: `cargo tree -p bun_js_parser -i bun_react_compiler` → must show this path.
