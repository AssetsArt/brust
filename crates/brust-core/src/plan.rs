//! The plan state of a planned loader call (M3-P P6), as data: what a host's `loader` is offered
//! (`PlanSeed`) and hands back (`PlannedCall`). Moved from `brust-server/src/pipeline.rs`.
//! Native-host seam (`doc(hidden)`), not an API.
use std::collections::BTreeMap;
use std::sync::Arc;

use brust_jinja::ctx::{MapInner, Node};

use crate::cache::JobKey;

/// Where a plan's template lives in the `PlanIndex` (M3-P P6: a plan stored across the
/// worker call is owned — [`PlanRow`] — and re-borrowed with `rehydrate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanSrc {
    /// The job's component in `PlanIndex::comps` (the child component for a child instance).
    pub comp: u32,
    /// The job in that component's `jobs`.
    pub job: u32,
    /// Child instance: (parent component, child record in the parent's `children`).
    pub via: Option<(u32, u32)>,
}

/// What survives the worker call of a plan: its template indices and its per-request strings.
#[derive(Debug, Clone)]
pub struct PlanRow {
    pub src: PlanSrc,
    pub row: Option<usize>,
    pub key: JobKey,
    pub user_key: Option<String>,
}

/// Job-cache state of a request's plans.
pub struct Lookup {
    /// The cached value per plan (`None` = a miss).
    pub values: Vec<Option<Arc<Node>>>,
    /// Plans sharing a JobKey (e.g. two identical rows) are one computation:
    /// `owner[i]` is the first missing plan with plan i's key; only owners are
    /// sent to the worker, and each value is fanned out to every plan sharing it.
    pub owner: Vec<usize>,
    /// The owners, in plan order.
    pub misses: Vec<usize>,
}

/// Put into the claimed slot by `page` before a planned loader call.
pub struct PlanSeed {
    /// The route's index in `manifest.routes`.
    pub route: usize,
    /// `params` + `path`, as `page` builds the context before the loader call.
    pub base: MapInner,
}

/// Left in the slot by `plan_in_call` (success only) for `page`.
pub struct PlannedCall {
    /// base + loader data (`merge_loader_data`), as `page` builds it.
    pub ctx: Node,
    /// The loader's response headers.
    pub headers: BTreeMap<String, String>,
    /// `collect_jobs`, owned (re-borrowed with `rehydrate` after the call).
    pub rows: Vec<PlanRow>,
    /// Hits pinned, owner, misses — exactly `lookup_jobs`'.
    pub lookup: Lookup,
    /// The ids of the misses' calls, request order.
    pub call_ids: Vec<String>,
}

/// The plan state of a planned loader call, in the claimed slot's cell (`pool::PlanBox`).
pub enum PlanCell {
    Seed(PlanSeed),
    Planned(PlannedCall),
}
