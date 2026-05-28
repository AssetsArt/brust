use swc_core::common::{FileName, SourceMap, sync::Lrc};
use swc_core::ecma::ast::Module;
// `Capturing` was moved behind the `unstable` feature gate in swc_ecma_parser 41
// (underlying swc_core 68); the upstream `examples/typescript.rs` itself comments
// it out as optional and passes the lexer directly to `Parser::new_from`. We
// follow the upstream example here.
use swc_core::ecma::parser::{Parser, StringInput, Syntax, TsSyntax, lexer::Lexer};

pub struct ParsedSource {
    pub module: Module,
    pub source_map: Lrc<SourceMap>,
}

// Manual Debug impl: swc_common 23's `SourceMap` does not implement Debug,
// so we cannot `#[derive(Debug)]`. Tests need `{:?}` on `Result<ParsedSource, _>`.
impl std::fmt::Debug for ParsedSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedSource")
            .field("module", &self.module)
            .field("source_map", &"<SourceMap>")
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("parse error: {0}")]
    Swc(String),
}

pub fn parse(source: &str, path: &str) -> Result<ParsedSource, ParseError> {
    let cm: Lrc<SourceMap> = Default::default();
    let fm = cm.new_source_file(
        Lrc::new(FileName::Custom(path.to_string())),
        source.to_string(),
    );

    let lexer = Lexer::new(
        Syntax::Typescript(TsSyntax {
            tsx: true,
            ..Default::default()
        }),
        Default::default(),
        StringInput::from(&*fm),
        None,
    );

    // Capturing wrapper omitted — see import comment above.
    let mut parser = Parser::new_from(lexer);

    match parser.parse_module() {
        Ok(module) => {
            let errs = parser.take_errors();
            if let Some(first) = errs.into_iter().next() {
                return Err(ParseError::Swc(format!("{first:?}")));
            }
            Ok(ParsedSource {
                module,
                source_map: cm,
            })
        }
        Err(err) => {
            // Drain any recovered errors too; T2 will surface them in diagnostics.
            let _recovered = parser.take_errors();
            Err(ParseError::Swc(format!("{err:?}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_tsx() {
        let src = "export default function Hi() { return <div/>; }";
        let parsed = parse(src, "<test>").unwrap();
        assert_eq!(parsed.module.body.len(), 1);
    }

    #[test]
    fn rejects_unterminated_jsx() {
        let src = "export default function Hi() { return <div; }";
        let err = parse(src, "<test>");
        assert!(err.is_err(), "expected parse error, got {err:?}");
    }

    #[test]
    fn accepts_typescript_destructured_props() {
        let src =
            "export default function Hi({ a, b }: { a: string; b: string }) { return <div/>; }";
        let parsed = parse(src, "<test>").unwrap();
        assert_eq!(parsed.module.body.len(), 1);
    }
}
