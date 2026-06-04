use std::env;
use std::fs;
use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: jsx-rustc <input.tsx> [-o <output>] [--check]");
        return ExitCode::from(2);
    }
    let input_path = &args[1];
    let mut output_path: Option<String> = None;
    let mut check_only = false;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "-o" => {
                i += 1;
                output_path = args.get(i).cloned();
            }
            "--check" => check_only = true,
            unknown => {
                eprintln!("unknown flag: {unknown}");
                return ExitCode::from(2);
            }
        }
        i += 1;
    }

    let source = match fs::read_to_string(input_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{input_path}: {e}");
            return ExitCode::from(1);
        }
    };

    match jsx_rust_compiler::compile_full(
        &source,
        input_path,
        std::collections::HashMap::new(),
        std::collections::HashMap::new(),
    ) {
        Ok(compiled) => {
            if check_only {
                // --check never writes either file — just confirm it compiles.
                println!("OK");
                return ExitCode::SUCCESS;
            }
            if let Some(out_path) = output_path {
                if let Err(e) = fs::write(&out_path, &compiled.template) {
                    eprintln!("{out_path}: {e}");
                    return ExitCode::from(1);
                }
                // Write the sibling island manifest only when there are islands
                // and we have a real `-o` path (stdout mode never writes one —
                // the build always uses `-o`).
                if !compiled.islands.is_empty() {
                    let manifest_path = manifest_path_for(&out_path);
                    let json = jsx_rust_compiler::islands_to_json(&compiled.islands);
                    if let Err(e) = fs::write(&manifest_path, &json) {
                        eprintln!("{manifest_path}: {e}");
                        return ExitCode::from(1);
                    }
                }
            } else {
                let _ = std::io::stdout().write_all(compiled.template.as_bytes());
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::from(1)
        }
    }
}

/// Derive the island-manifest path from the `-o` output path: replace a
/// trailing `.jinja` with `.islands.json`; if the path doesn't end in `.jinja`,
/// append `.islands.json` to the whole path.
fn manifest_path_for(out_path: &str) -> String {
    match out_path.strip_suffix(".jinja") {
        Some(stem) => format!("{stem}.islands.json"),
        None => format!("{out_path}.islands.json"),
    }
}

#[cfg(test)]
mod tests {
    use super::manifest_path_for;

    #[test]
    fn manifest_path_replaces_jinja_suffix() {
        assert_eq!(manifest_path_for("out/page.jinja"), "out/page.islands.json");
    }

    #[test]
    fn manifest_path_appends_when_no_jinja_suffix() {
        assert_eq!(manifest_path_for("out/page"), "out/page.islands.json");
        assert_eq!(
            manifest_path_for("out/page.html"),
            "out/page.html.islands.json"
        );
    }
}
