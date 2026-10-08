//! Plain-Rust view of the React Compiler's analysis of one component. Later
//! stages consume this, never the Bun HIR types (spec §9).

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct HirSummary {
    pub function: String,
    pub params: usize,
    pub scopes: Vec<ScopeInfo>,
    pub identifiers: usize,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct ScopeInfo {
    pub id: u32,
    pub deps: Vec<DepInfo>,
    pub decls: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
pub struct DepInfo {
    pub name: String,
    pub reactive: bool,
}
