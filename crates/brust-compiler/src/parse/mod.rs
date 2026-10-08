//! Parse a `.tsx` file with Bun's parser. The only module (with `analyze`) that
//! names `bun_ast` types. Everything stays private except the plain accessors.
#[cfg(feature = "bun-stubs")]
mod stubs;

use bun_ast as js_ast;

/// A parsed module. Owns every buffer the AST borrows: the source bytes, the
/// arena its nodes live in, and the allocator whose `AstAlloc` state holds its
/// interior vectors. Fields drop in declaration order, so the AST goes first and
/// the buffers it points into go last.
pub struct Parsed {
    ast: Box<js_ast::Ast<'static>>,
    default_export_fn: Option<String>,
    import_paths: Vec<String>,
    source: Box<js_ast::Source>,
    _define: Box<bun_js_parser::Define>,
    // Holds the `AstAllocState` the parser's `AstVec`s were carved from. Its
    // scope is closed when `parse_tsx` returns (the thread-local is restored),
    // but the state stays owned here until `Parsed` drops. Borrows `arena`.
    _ast_alloc: Box<js_ast::ASTMemoryAllocator>,
    arena: Box<bun_alloc::Arena>,
    _text: Box<[u8]>,
    _path: Box<[u8]>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message} ({line}:{column})")]
pub struct ParseError {
    pub message: String,
    pub line: u32,
    pub column: u32,
}

/// Bytes kept free at the bottom of the thread's stack when Bun's recursion
/// guard trips; the guard's own unwinding and our error path run in it.
#[cfg(feature = "bun-stubs")]
const STACK_GUARD_MARGIN: usize = 128 << 10;

/// Bun's recursion guard reads a per-thread limit; set it once per thread from
/// the real stack bounds (test threads have 2 MiB stacks, `main` has 8 MiB).
#[cfg(feature = "bun-stubs")]
fn ensure_stack_limit() {
    thread_local!(static READY: core::cell::Cell<bool> = const { core::cell::Cell::new(false) });
    if READY.get() {
        return;
    }
    let probe = 0u8;
    let here = (&raw const probe).addr();
    let remaining = stack_bottom()
        .map(|bottom| here.saturating_sub(bottom + STACK_GUARD_MARGIN))
        .unwrap_or(1 << 20);
    stubs::native::set_stack_size(remaining);
    READY.set(true);
}

/// Lowest usable address of the current thread's stack.
#[cfg(all(feature = "bun-stubs", target_os = "macos"))]
fn stack_bottom() -> Option<usize> {
    // SAFETY: both calls only read the calling thread's own attributes.
    unsafe {
        let me = libc::pthread_self();
        let top = libc::pthread_get_stackaddr_np(me).addr();
        Some(top - libc::pthread_get_stacksize_np(me))
    }
}

/// Lowest usable address of the current thread's stack.
#[cfg(all(feature = "bun-stubs", target_os = "linux"))]
fn stack_bottom() -> Option<usize> {
    // SAFETY: `attr` is initialised by `pthread_getattr_np` before it is read and
    // destroyed exactly once.
    unsafe {
        let mut attr = core::mem::MaybeUninit::<libc::pthread_attr_t>::uninit();
        if libc::pthread_getattr_np(libc::pthread_self(), attr.as_mut_ptr()) != 0 {
            return None;
        }
        let mut addr = core::ptr::null_mut();
        let mut size = 0usize;
        let ok = libc::pthread_attr_getstack(attr.as_ptr(), &mut addr, &mut size) == 0;
        libc::pthread_attr_destroy(attr.as_mut_ptr());
        ok.then(|| addr.addr())
    }
}

#[cfg(all(
    feature = "bun-stubs",
    not(any(target_os = "macos", target_os = "linux"))
))]
fn stack_bottom() -> Option<usize> {
    None
}

/// Lifetime-erased view of a boxed value, for the self-referential `Parsed`.
///
/// # Safety
/// The box must outlive every use of the returned reference and must not be
/// mutated or dropped while it is alive.
unsafe fn boxed<T: ?Sized>(b: &T) -> &'static T {
    // SAFETY: forwarded to the caller.
    unsafe { &*core::ptr::from_ref::<T>(b) }
}

pub fn parse_tsx(path: &str, source: Vec<u8>) -> Result<Parsed, ParseError> {
    #[cfg(feature = "bun-stubs")]
    ensure_stack_limit();

    let text: Box<[u8]> = source.into_boxed_slice();
    let path_box: Box<[u8]> = path.as_bytes().into();
    let arena = Box::new(bun_alloc::Arena::new());
    // SAFETY (every `boxed` call below): each box is moved into `Parsed` and never
    // mutated or reallocated, so its heap address is stable, and `Parsed`'s field
    // order drops every borrower before the box it borrows.
    let (text_ref, path_ref, arena_ref) =
        unsafe { (boxed(&*text), boxed(&*path_box), boxed(&*arena)) };
    let mut ast_alloc = Box::new(js_ast::ASTMemoryAllocator::borrowing(arena_ref));
    let src = Box::new(js_ast::Source::init_path_string(path_ref, text_ref));
    let define = Box::new(bun_js_parser::Define::default());
    let (src_ref, define_ref) = unsafe { (boxed(&*src), boxed(&*define)) };

    let (result, log) = {
        // The scope routes the parser's node and `AstVec` allocations into
        // `arena` / `ast_alloc` and is closed before we return, so a second
        // parse on this thread starts from a clean thread-local.
        let _scope = ast_alloc.enter();
        let mut opts = bun_js_parser::ParserOptions::init(Default::default(), js_ast::Loader::Tsx);
        opts.features.no_macros = true;
        opts.features.react_compiler = js_ast::runtime::ReactCompilerMode::Disabled;
        let mut log = js_ast::Log::init();
        let result =
            match bun_js_parser::Parser::init(opts, &mut log, src_ref, define_ref, arena_ref) {
                Ok(parser) => parser.parse(),
                Err(e) => Err(e),
            };
        (result, log)
    };
    if log.errors > 0 {
        return Err(first_error(&log, text_ref));
    }
    let ast = match result {
        Ok(bun_js_parser::Result::Ast(ast)) => ast,
        Ok(_) => return Err(plain_error("parser did not return an AST")),
        Err(e) => return Err(plain_error(&format!("{e:?}"))),
    };

    let import_paths = ast
        .import_records
        .as_slice()
        .iter()
        .map(|r| String::from_utf8_lossy(r.path.text).into_owned())
        .collect();
    let default_export_fn = find_default_export_fn(&ast);

    Ok(Parsed {
        ast,
        default_export_fn,
        import_paths,
        source: src,
        _define: define,
        _ast_alloc: ast_alloc,
        arena,
        _text: text,
        _path: path_box,
    })
}

fn plain_error(message: &str) -> ParseError {
    ParseError {
        message: message.to_string(),
        line: 0,
        column: 0,
    }
}

/// The first error in `log`. Bun's `Location` line and column are both 1-based
/// (the column counts UTF-16 units).
fn first_error(log: &js_ast::Log, text: &[u8]) -> ParseError {
    let msg = log
        .msgs
        .iter()
        .find(|m| matches!(m.kind, js_ast::Kind::Err))
        .or(log.msgs.first());
    let Some(m) = msg else {
        return plain_error("parse failed");
    };
    let (line, column) = match &m.data.location {
        Some(l) if l.line > 0 => (l.line as u32, l.column.max(1) as u32),
        Some(l) => offset_to_line_col(text, l.offset),
        None => (0, 0),
    };
    ParseError {
        message: String::from_utf8_lossy(&m.data.text).into_owned(),
        line,
        column,
    }
}

fn offset_to_line_col(text: &[u8], offset: usize) -> (u32, u32) {
    let mut line = 1u32;
    let mut col = 1u32;
    for &b in &text[..offset.min(text.len())] {
        if b == b'\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

fn find_default_export_fn(ast: &js_ast::Ast<'_>) -> Option<String> {
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            if let js_ast::stmt::Data::SExportDefault(ed) = &stmt.data
                && let js_ast::StmtOrExpr::Stmt(inner) = &ed.value
                && let js_ast::stmt::Data::SFunction(sf) = &inner.data
            {
                let name = sf.func.name.as_ref().map(|n| {
                    let sym = &ast.symbols.as_slice()[n.ref_.inner_index() as usize];
                    String::from_utf8_lossy(sym.original_name.slice()).into_owned()
                });
                return name.or(Some(String::new()));
            }
        }
    }
    None
}

impl Parsed {
    pub fn symbol_count(&self) -> usize {
        self.ast.symbols.len()
    }

    pub fn import_paths(&self) -> Vec<String> {
        self.import_paths.clone()
    }

    pub fn default_export_function_name(&self) -> Option<String> {
        self.default_export_fn.clone()
    }

    pub(crate) fn ast(&self) -> &js_ast::Ast<'static> {
        &self.ast
    }

    pub(crate) fn source(&self) -> &js_ast::Source {
        &self.source
    }

    pub(crate) fn arena(&self) -> &bun_alloc::Arena {
        &self.arena
    }
}
