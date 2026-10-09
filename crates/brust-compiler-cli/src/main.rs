//! brustc — the v2 compiler CLI:
//! `--emit parse|hir|ir|diag|template|server|client|all [--out <dir>] [--runtime-import <spec>]`.
use std::process::ExitCode;

const USAGE: &str = "usage: brustc <file.tsx> --emit parse|hir|ir|diag|template|server|client|all [--out <dir>] [--runtime-import <spec>]";

struct Args {
    file: String,
    emit: String,
    out: Option<String>,
    runtime_import: String,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(args) = parse_args(&args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let (file, emit) = (args.file.clone(), args.emit.clone());
    if ![
        "parse", "hir", "ir", "diag", "template", "server", "client", "all",
    ]
    .contains(&emit.as_str())
    {
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
    if ["template", "server", "client", "all"].contains(&emit.as_str()) {
        return brust_compiler::parse::run_on_compiler_thread(|| emit_lowered(&args, source));
    }
    brust_compiler::parse::run_on_compiler_thread(|| run(&file, &emit, source))
}

/// `template|server|client` print one artifact of the input component;
/// `all --out <dir>` writes every compiled component's artifacts and prints
/// the file list.
fn emit_lowered(args: &Args, source: Vec<u8>) -> ExitCode {
    use brust_compiler::analyze::component::AnalyzeOptions;
    use brust_compiler::ir::render_diagnostics;
    let tree = match brust_compiler::pipeline::compile_tree(
        &args.file,
        Some(source),
        &AnalyzeOptions::default(),
        &args.runtime_import,
    ) {
        Ok(t) => t,
        Err(d) => {
            eprint!("{}", render_diagnostics(&[d], &args.file));
            return ExitCode::from(1);
        }
    };
    let root = &tree[0].artifacts;
    match args.emit.as_str() {
        "template" => print!("{}", root.jinja),
        "server" => print!("{}", root.server_ts.as_deref().unwrap_or("")),
        "client" => print!("{}", root.client_js.as_deref().unwrap_or("")),
        _ => {
            let Some(dir) = &args.out else {
                eprintln!("error: --emit all needs --out <dir>\n{USAGE}");
                return ExitCode::from(2);
            };
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!("error: cannot create {dir}: {e}");
                return ExitCode::from(1);
            }
            for l in &tree {
                let id = &l.ir.id;
                let files = [
                    (format!("{id}.jinja"), Some(&l.artifacts.jinja)),
                    (format!("{id}.server.ts"), l.artifacts.server_ts.as_ref()),
                    (format!("{id}.client.js"), l.artifacts.client_js.as_ref()),
                ];
                for (name, text) in files {
                    let Some(text) = text else { continue };
                    let path = std::path::Path::new(dir).join(&name);
                    if let Err(e) = std::fs::write(&path, text) {
                        eprintln!("error: cannot write {}: {e}", path.display());
                        return ExitCode::from(1);
                    }
                    println!("{}", path.display());
                }
            }
        }
    }
    ExitCode::SUCCESS
}

fn run(file: &str, emit: &str, source: Vec<u8>) -> ExitCode {
    let parsed = match brust_compiler::parse::parse_tsx(file, source) {
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
    if emit == "ir" || emit == "diag" {
        return emit_ir(file, emit);
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

/// `ir`: the ComponentIR as pretty JSON. `diag`: one line per diagnostic; exit 1
/// when any is an `Error` (or the module has no default export). Child
/// components are resolved relative to the current directory.
fn emit_ir(file: &str, emit: &str) -> ExitCode {
    use brust_compiler::analyze::component::{AnalyzeOptions, analyze_file};
    use brust_compiler::ir::{DiagClass, render_diagnostics};
    let ir = match analyze_file(file, &AnalyzeOptions::default()) {
        Ok(ir) => ir,
        Err(d) => {
            eprint!("{}", render_diagnostics(&[d], file));
            return ExitCode::from(1);
        }
    };
    if emit == "ir" {
        println!("{}", serde_json::to_string_pretty(&ir).unwrap());
        return ExitCode::SUCCESS;
    }
    print!("{}", render_diagnostics(&ir.diagnostics, file));
    if ir.diagnostics.iter().any(|d| d.class == DiagClass::Error) {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}

fn parse_args(args: &[String]) -> Option<Args> {
    let mut file = None;
    let mut emit = None;
    let mut out = None;
    let mut runtime_import = brust_compiler::lower::DEFAULT_RUNTIME_IMPORT.to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--emit" => {
                emit = Some(args.get(i + 1)?.clone());
                i += 2;
            }
            "--out" => {
                out = Some(args.get(i + 1)?.clone());
                i += 2;
            }
            "--runtime-import" => {
                runtime_import = args.get(i + 1)?.clone();
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
    Some(Args {
        file: file?,
        emit: emit?,
        out,
        runtime_import,
    })
}
