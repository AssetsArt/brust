use swc_core::common::Span;
use crate::ErrorKind;
use crate::parser::ParsedSource;
use crate::ir::Component;

pub struct LowerError {
    pub span: Span,
    pub kind: ErrorKind,
}

pub fn lower(_parsed: &ParsedSource) -> Result<Component, LowerError> {
    todo!("populated in T3")
}
