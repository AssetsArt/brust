use crate::ErrorKind;
use crate::ir::Component;
use crate::parser::ParsedSource;
use swc_core::common::Span;

pub struct LowerError {
    pub span: Span,
    pub kind: ErrorKind,
}

pub fn lower(_parsed: &ParsedSource) -> Result<Component, LowerError> {
    todo!("populated in T3")
}
