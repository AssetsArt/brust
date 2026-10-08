use crate::parse::Parsed;

#[derive(Debug, thiserror::Error)]
pub enum HirError {
    #[error("no `export default function` in this module")]
    NoDefaultExportFunction,
    #[error("react compiler could not lower this component: {0}")]
    Unsupported(String),
}

pub fn analyze_hir(_parsed: &Parsed) -> Result<crate::summary::HirSummary, HirError> {
    Err(HirError::Unsupported("not implemented".into()))
}
