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
    /// The alias imports rewritten at parse time (`tsconfig` `paths`, R34.76).
    alias_imports: Vec<crate::analyze::aliases::AliasImport>,
    /// Owns the rewritten specifiers the import records borrow.
    _alias_text: Vec<Box<[u8]>>,
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

/// Lowest usable address of the current thread's stack. Windows reserves the whole
/// stack up front (Rust's `thread::Builder::stack_size` passes it as a reservation),
/// so the low limit is the bottom of the 256 MiB compiler stack, not of the committed part.
#[cfg(all(feature = "bun-stubs", windows))]
fn stack_bottom() -> Option<usize> {
    let (mut low, mut high) = (0usize, 0usize);
    // SAFETY: both out-pointers are valid for writes; the call only reads the calling thread's TEB.
    unsafe {
        windows_sys::Win32::System::Threading::GetCurrentThreadStackLimits(&mut low, &mut high)
    };
    (low != 0 && high > low).then_some(low)
}

#[cfg(all(
    feature = "bun-stubs",
    not(any(target_os = "macos", target_os = "linux", windows))
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

/// Stack size of the compiler thread. Bun's parser guards its recursion against
/// the per-thread limit `ensure_stack_limit` sets, but the vendored React Compiler
/// and our own readers recurse without a guard (ledger F1); 256 MiB keeps
/// a 6000-deep JSX tree or a 6000-term expression well inside the stack.
const COMPILER_STACK: usize = 256 << 20;

/// Runs `f` on a dedicated thread with a 256 MiB stack and returns its result.
///
/// Every compiler entry point (`parse_tsx`, `analyze_hir`, `analyze_component`)
/// must be called inside this: on an ordinary 2–8 MiB thread, valid input that
/// parses can still overflow the stack later and abort the process. `Parsed` is
/// `!Send`, so parse and analysis of one module happen inside the same call.
/// The thread is scoped, so `f` may borrow from the caller. A panic in `f` is
/// re-raised on the calling thread.
pub fn run_on_compiler_thread<T: Send>(f: impl FnOnce() -> T + Send) -> T {
    std::thread::scope(|s| {
        std::thread::Builder::new()
            .name("brust-compiler".into())
            .stack_size(COMPILER_STACK)
            .spawn_scoped(s, || {
                #[cfg(feature = "bun-stubs")]
                ensure_stack_limit();
                f()
            })
            .expect("spawn the compiler thread")
            .join()
            .unwrap_or_else(|e| std::panic::resume_unwind(e))
    })
}

/// Parses one module: `.tsx` (and any other name) as TSX, `.ts` / `.mts` / `.cts` as TypeScript. Call it inside [`run_on_compiler_thread`].
pub fn parse_tsx(path: &str, source: Vec<u8>) -> Result<Parsed, ParseError> {
    crate::stats::parsed(path);
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
        // F599 (O3): a `.ts` module is TypeScript, not TSX: in TSX `<T>(l: T): T => l` opens a JSX element, so a generic
        // arrow written without a trailing comma did not parse as an arrow. A `.tsx` module (and any other name) is TSX.
        let loader = if [".ts", ".mts", ".cts"].iter().any(|e| path.ends_with(e)) {
            js_ast::Loader::Ts
        } else {
            js_ast::Loader::Tsx
        };
        let mut opts = bun_js_parser::ParserOptions::init(Default::default(), loader);
        opts.features.no_macros = true;
        opts.features.react_compiler = js_ast::runtime::ReactCompilerMode::Disabled;
        // Lower JSX to `jsx`/`jsxs(tag, props[, key])`, never the 6-arg `jsxDEV`.
        opts.jsx.development = false;
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
    let mut ast = match result {
        Ok(bun_js_parser::Result::Ast(ast)) => ast,
        Ok(_) => return Err(plain_error("parser did not return an AST")),
        Err(e) => return Err(plain_error(&format!("{e:?}"))),
    };

    // `tsconfig` `paths`: an alias specifier becomes the relative one of the file it names, so every later stage
    // reads an ordinary relative import. The new text lives in `_alias_text` (boxes never move).
    let mut alias_imports = Vec::new();
    let mut alias_text: Vec<Box<[u8]>> = Vec::new();
    for r in ast.import_records.as_mut_slice() {
        let spec = String::from_utf8_lossy(r.path.text).into_owned();
        if let Some((rel, target)) = crate::analyze::aliases::rewrite(path, &spec) {
            alias_text.push(rel.into_bytes().into_boxed_slice());
            // SAFETY: the box is moved into `Parsed` (`_alias_text`), never mutated, and dropped after `ast`.
            r.path.text = unsafe { boxed(&**alias_text.last().expect("just pushed")) };
            alias_imports.push(crate::analyze::aliases::AliasImport {
                from: path.to_string(),
                spec,
                target,
            });
        }
    }
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
        alias_imports,
        _alias_text: alias_text,
        source: src,
        _define: define,
        _ast_alloc: ast_alloc,
        arena,
        _text: text,
        _path: path_box,
    })
}

/// F535: the modules one analysis run parsed, by (alias scope, path) and checked against the exact text, so a module
/// read again (by the contexts walk, element-freedom, barrels, ...) is parsed once per run. Only open while a
/// [`ParseCache`] guard is alive (`analyze_with` holds one), so no parse outlives the run that made it.
#[derive(Default)]
struct Cache {
    parses: std::collections::HashMap<(u64, String), Vec<std::rc::Rc<Parsed>>>,
    /// `plain_fn::module_may_hold_element`, by (alias scope, resolved module path, depth).
    may_hold: std::collections::HashMap<(u64, String, u8), bool>,
    /// F620 D1: what this run read of each file (`root.join(path)`): its bytes, or why it cannot be read. A run is one
    /// native call and nothing writes app files during one, so a file is read once per run.
    sources: std::collections::HashMap<std::path::PathBuf, Result<std::rc::Rc<[u8]>, ReadError>>,
    /// F620 D1: the parse of each file [`parse_file`] read, by (alias scope, root, path): a hit needs no text compare
    /// (the bytes are `sources`'s).
    files: std::collections::HashMap<(u64, std::path::PathBuf, String), std::rc::Rc<Parsed>>,
    /// F620 D2: what is derived from one module alone ([`memo`]), by (kind, alias scope, root, path, question).
    memos: std::collections::HashMap<MemoKey, Box<dyn std::any::Any>>,
}

type MemoKey = (&'static str, u64, std::path::PathBuf, String, String);

/// F620 D1: why a file could not be read (the error of the read itself, shared by every reader of the run).
#[derive(Clone, Debug)]
pub struct ReadError(std::rc::Rc<std::io::Error>);

impl ReadError {
    pub fn kind(&self) -> std::io::ErrorKind {
        self.0.kind()
    }
}

impl core::fmt::Display for ReadError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        self.0.fmt(f)
    }
}

/// F620 D1: why [`parse_file`] has no module: the file cannot be read, or it does not parse.
#[derive(Debug)]
pub enum FileError {
    Read(ReadError),
    Parse(ParseError),
}

fn cache_open() -> bool {
    CACHE.with(|c| c.borrow().is_some())
}

/// F620 D1: the bytes of the file `root / path`, read once per run while a [`ParseCache`] is open (a file that cannot
/// be read stays so for the run); without an open cache it reads every time.
pub fn read_source(root: &std::path::Path, path: &str) -> Result<std::rc::Rc<[u8]>, ReadError> {
    let full = root.join(path);
    if !cache_open() {
        return std::fs::read(&full)
            .map(std::rc::Rc::from)
            .map_err(|e| ReadError(std::rc::Rc::new(e)));
    }
    if let Some(r) = CACHE.with(|c| {
        c.borrow()
            .as_ref()
            .and_then(|m| m.sources.get(&full).cloned())
    }) {
        return r;
    }
    let r = std::fs::read(&full)
        .map(std::rc::Rc::from)
        .map_err(|e| ReadError(std::rc::Rc::new(e)));
    CACHE.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            m.sources.insert(full, r.clone());
        }
    });
    r
}

/// F620 D1: the module at `root / path`, read through [`read_source`] and parsed through the run's cache: one read and
/// one parse per file and alias scope per run. Without an open cache it reads and parses every time (as
/// `std::fs::read` + [`parse_cached`] did). A parse error is not kept.
pub fn parse_file(root: &std::path::Path, path: &str) -> Result<std::rc::Rc<Parsed>, FileError> {
    if !cache_open() {
        let bytes = std::fs::read(root.join(path))
            .map_err(|e| FileError::Read(ReadError(std::rc::Rc::new(e))))?;
        return parse_tsx(path, bytes)
            .map(std::rc::Rc::new)
            .map_err(FileError::Parse);
    }
    let key = (
        crate::analyze::aliases::scope_id(),
        root.to_path_buf(),
        path.to_string(),
    );
    if let Some(p) = CACHE.with(|c| c.borrow().as_ref().and_then(|m| m.files.get(&key).cloned())) {
        return Ok(p);
    }
    let bytes = read_source(root, path).map_err(FileError::Read)?;
    // Through `parse_cached`: a module the run was GIVEN with the same text (the entry of `compile_source`) is shared.
    let p = parse_cached(path, bytes.to_vec()).map_err(FileError::Parse)?;
    CACHE.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            m.files.insert(key, p.clone());
        }
    });
    Ok(p)
}

/// F620 D2: `f()`, memoised for the run by (`kind`, alias scope, `root`, `path`, `question`) while a [`ParseCache`] is
/// open; without one it runs every time. RULE: the value must be a pure function of the text of the module `path`
/// (read through [`parse_file`]), the alias scope and `question`, nothing else of the run's options.
pub(crate) fn memo<T: Clone + 'static>(
    kind: &'static str,
    root: &std::path::Path,
    path: &str,
    question: &str,
    f: impl FnOnce() -> T,
) -> T {
    if !cache_open() {
        return f();
    }
    let key: MemoKey = (
        kind,
        crate::analyze::aliases::scope_id(),
        root.to_path_buf(),
        path.to_string(),
        question.to_string(),
    );
    let hit = CACHE.with(|c| {
        c.borrow()
            .as_ref()
            .and_then(|m| m.memos.get(&key))
            .and_then(|v| v.downcast_ref::<T>())
            .cloned()
    });
    if let Some(v) = hit {
        return v;
    }
    // Computed with the cache NOT borrowed: `f` reads and parses through it.
    let v = f();
    CACHE.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            m.memos.insert(key, Box::new(v.clone()));
        }
    });
    v
}

/// F535: `module_may_hold_element`'s answer for a resolved module at a depth, memoised for the run (`None` when no run
/// cache is open or it was not asked yet).
pub(crate) fn may_hold_memo(path: &str, depth: u8) -> Option<bool> {
    let key = (crate::analyze::aliases::scope_id(), path.to_string(), depth);
    CACHE.with(|c| c.borrow().as_ref()?.may_hold.get(&key).copied())
}

pub(crate) fn may_hold_remember(path: &str, depth: u8, v: bool) {
    let key = (crate::analyze::aliases::scope_id(), path.to_string(), depth);
    CACHE.with(|c| {
        if let Some(m) = c.borrow_mut().as_mut() {
            m.may_hold.insert(key, v);
        }
    });
}

thread_local!(static CACHE: core::cell::RefCell<Option<Cache>> = const { core::cell::RefCell::new(None) });

/// Opens the parse cache for this thread until dropped; nested guards share the outermost one.
pub struct ParseCache(bool);

impl ParseCache {
    pub fn enter() -> ParseCache {
        CACHE.with(|c| {
            let mut c = c.borrow_mut();
            let open = c.is_none();
            if open {
                *c = Some(Cache::default());
            }
            ParseCache(open)
        })
    }
}

impl Drop for ParseCache {
    fn drop(&mut self) {
        if self.0 {
            // Taken out before it drops: a `Parsed` dropping never runs with the cache borrowed.
            let cache = CACHE.with(|c| c.borrow_mut().take());
            drop(cache);
        }
    }
}

/// [`parse_tsx`] through the run's cache: the same path, text and alias scope give the same `Parsed`. Without an
/// open cache it parses every time. A parse error is not kept (the caller fails closed on it anyway).
pub fn parse_cached(path: &str, source: Vec<u8>) -> Result<std::rc::Rc<Parsed>, ParseError> {
    let key = (crate::analyze::aliases::scope_id(), path.to_string());
    let hit = CACHE.with(|c| {
        c.borrow().as_ref().map(|m| {
            m.parses
                .get(&key)
                .and_then(|v| v.iter().find(|p| p.text() == source.as_slice()).cloned())
        })
    });
    match hit {
        Some(Some(p)) => Ok(p),
        Some(None) => {
            let p = std::rc::Rc::new(parse_tsx(path, source)?);
            CACHE.with(|c| {
                if let Some(m) = c.borrow_mut().as_mut() {
                    m.parses.entry(key).or_default().push(p.clone());
                }
            });
            Ok(p)
        }
        None => parse_tsx(path, source).map(std::rc::Rc::new),
    }
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

    /// The path the module was parsed under.
    pub fn path(&self) -> String {
        String::from_utf8_lossy(&self._path).into_owned()
    }

    /// The module's source text.
    pub fn text(&self) -> &[u8] {
        &self._text
    }

    /// The alias imports this module wrote (`tsconfig` `paths`).
    pub fn alias_imports(&self) -> Vec<crate::analyze::aliases::AliasImport> {
        self.alias_imports.clone()
    }

    pub fn import_paths(&self) -> Vec<String> {
        self.import_paths.clone()
    }

    pub fn default_export_function_name(&self) -> Option<String> {
        self.default_export_fn.clone()
    }

    /// Lends the AST for the duration of `f`. The borrow cannot escape the
    /// closure, so nothing read from it can outlive `Parsed` (ledger F2).
    pub fn with_ast<R>(&self, f: impl FnOnce(&js_ast::Ast<'_>) -> R) -> R {
        f(&self.ast)
    }

    pub(crate) fn source(&self) -> &js_ast::Source {
        &self.source
    }

    pub(crate) fn arena(&self) -> &bun_alloc::Arena {
        &self.arena
    }
}

#[cfg(test)]
mod run_cache_tests;
