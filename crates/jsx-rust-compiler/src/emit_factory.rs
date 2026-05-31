// crates/jsx-rust-compiler/src/emit_factory.rs (stub — Task 4 fills this in)
pub struct FactoryOutput {
    pub expr: String,
    pub referenced: Vec<String>,
    pub uses_island: bool,
}

pub fn emit(_component: &crate::ir::Component) -> Vec<FactoryOutput> {
    vec![]
}
