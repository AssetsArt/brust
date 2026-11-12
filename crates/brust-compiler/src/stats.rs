//! F535: work counters for one `compile_tree` run (per compiler thread). `pipeline::compile_tree` resets them at its
//! start; `take` reads them after. They count what the run did — parses per file, component analyses, module
//! compiles — so a test can assert the work stays linear in the size of the tree.
use std::cell::RefCell;
use std::collections::BTreeMap;

/// What one `compile_tree` run did, by key.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Stats {
    /// `parse_tsx` calls that parsed (a cache hit is not counted), by module path.
    pub parses: BTreeMap<String, u32>,
    /// Component analyses (`analyze_named_component_in` / `analyze_component_in`), by `path#name`.
    pub analyses: BTreeMap<String, u32>,
    /// Pass pipelines run on a component (`run_passes`), by component id.
    pub pass_runs: BTreeMap<String, u32>,
}

impl Stats {
    pub fn total_parses(&self) -> u32 {
        self.parses.values().sum()
    }
    pub fn total_analyses(&self) -> u32 {
        self.analyses.values().sum()
    }
    pub fn total_pass_runs(&self) -> u32 {
        self.pass_runs.values().sum()
    }
}

thread_local!(static STATS: RefCell<Stats> = RefCell::new(Stats::default()));

pub(crate) fn reset() {
    STATS.with(|s| *s.borrow_mut() = Stats::default());
}

/// The counters of the last `compile_tree` run on this thread.
pub fn take() -> Stats {
    STATS.with(|s| std::mem::take(&mut *s.borrow_mut()))
}

pub(crate) fn parsed(path: &str) {
    STATS.with(|s| *s.borrow_mut().parses.entry(path.to_string()).or_default() += 1);
}

pub(crate) fn analysed(path: &str, name: &str) {
    STATS.with(|s| {
        *s.borrow_mut()
            .analyses
            .entry(format!("{path}#{name}"))
            .or_default() += 1
    });
}

pub(crate) fn passes_ran(id: &str) {
    STATS.with(|s| *s.borrow_mut().pass_runs.entry(id.to_string()).or_default() += 1);
}
