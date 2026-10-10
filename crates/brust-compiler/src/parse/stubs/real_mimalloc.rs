//! The thread-pool hooks Bun's mimalloc fork adds and upstream mimalloc lacks.
//! `native.rs` provides them only without `bun_sema_mimalloc`; with the real
//! (upstream) library linked (feature `real-mimalloc`) they live here, same bodies.
//! The fourth fork hook `native.rs` fakes, `mi_thread_set_in_threadpool`, is
//! exported by upstream mimalloc v3 itself (src/init.c), so it is not stubbed here:
//! a second definition is a duplicate symbol at link time.

// Load the crate so libmimalloc-sys's static archive is linked into every binary
// that has the feature on (brust-compiler's own tests, brust-compiler-cli under
// workspace feature unification): rustc does not link an unreferenced dependency.
use mimalloc as _;

#[unsafe(no_mangle)]
extern "C" fn mi_on_thread_idle() {}
#[unsafe(no_mangle)]
extern "C" fn mi_on_thread_idle_start() -> bool {
    false
}
#[unsafe(no_mangle)]
extern "C" fn mi_on_thread_idle_end() {}
