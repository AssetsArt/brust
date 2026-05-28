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

    match jsx_rust_compiler::compile_with_path(&source, input_path) {
        Ok(emitted) => {
            if check_only {
                println!("OK");
                return ExitCode::SUCCESS;
            }
            if let Some(out_path) = output_path {
                if let Err(e) = fs::write(&out_path, &emitted) {
                    eprintln!("{out_path}: {e}");
                    return ExitCode::from(1);
                }
            } else {
                let _ = std::io::stdout().write_all(emitted.as_bytes());
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::from(1)
        }
    }
}
