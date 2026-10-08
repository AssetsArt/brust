//! brustc — the v2 compiler CLI. M1a: `--emit parse|hir`.
use std::process::ExitCode;

const USAGE: &str = "usage: brustc <file.tsx> --emit parse|hir";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((file, emit)) = parse_args(&args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    if emit != "parse" && emit != "hir" {
        eprintln!("error: unknown --emit {emit}\n{USAGE}");
        return ExitCode::from(2);
    }
    let source = match std::fs::read(&file) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot read {file}: {e}");
            return ExitCode::from(1);
        }
    };
    let parsed = match brust_compiler::parse::parse_tsx(&file, source) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {} ({file}:{}:{})", e.message, e.line, e.column);
            return ExitCode::from(1);
        }
    };
    if emit == "parse" {
        let v = serde_json::json!({
            "file": file,
            "symbols": parsed.symbol_count(),
            "imports": parsed.import_paths(),
            "default_export_function": parsed.default_export_function_name(),
        });
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
        return ExitCode::SUCCESS;
    }
    match brust_compiler::analyze::hir::analyze_hir(&parsed) {
        Ok(summary) => {
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e} ({file})");
            ExitCode::from(1)
        }
    }
}

fn parse_args(args: &[String]) -> Option<(String, String)> {
    let mut file = None;
    let mut emit = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--emit" => {
                emit = Some(args.get(i + 1)?.clone());
                i += 2;
            }
            a if a.starts_with("--") => return None,
            a => {
                if file.replace(a.to_string()).is_some() {
                    return None;
                }
                i += 1;
            }
        }
    }
    Some((file?, emit?))
}
