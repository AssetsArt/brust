//! `dist/manifest.json` (spec §3 S6): the only contract between `brust build`
//! and the server. Read once at boot; every reference it makes (templates,
//! client chunks, assets, chain components, child job inputs) is checked here
//! so a bad manifest fails `start` instead of a request (spec §7).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Field names are exactly spec S6. `BTreeMap` so iteration is deterministic.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub routes: Vec<RouteRecord>,
    pub components: BTreeMap<String, ComponentRecord>,
    pub assets: Assets,
    pub jobs_module: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RouteRecord {
    pub id: String,
    pub pattern: String,
    pub chain: Vec<String>,
    pub loaders: Vec<String>,
    pub cache: Option<RouteCache>,
    pub catch_all: bool,
}

/// Route-level L1 directives (0.1.x `CacheConfig`, `response_cache.rs:22-35`;
/// `tags` is a plain list here, `[]` = none).
#[derive(Debug, Clone, Deserialize)]
pub struct RouteCache {
    pub ttl_seconds: u64,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub bypass: Option<BypassSpec>,
    #[serde(default)]
    pub tags: Vec<String>,
}

// Per-request bypass: `true` ⇒ always skip L1; a string ⇒ a key-expression
// whose non-empty result ⇒ skip L1. Untagged so JSON `true` / "expr" both
// deserialize (bool and string are disjoint JSON types — no ambiguity).
// Carried from `response_cache.rs:15-20`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum BypassSpec {
    Always(bool),
    Expr(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComponentRecord {
    pub tier: Tier,
    pub template: String,
    #[serde(default)]
    pub jobs: Vec<JobRecord>,
    #[serde(default)]
    pub children: Vec<ChildRecord>,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub needs_worker: bool,
    #[serde(default)]
    pub use_id_slots: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Static,
    Native,
    React,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JobRecord {
    pub id: String,
    pub kind: JobKind,
    pub inputs: Vec<String>,
    #[serde(default)]
    pub per_instance: Option<String>,
    #[serde(default)]
    pub cache: JobCache,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Precompute,
    Ssr,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct JobCache {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

/// One inlined child instance group of a component. `props` maps each child
/// prop name to a parent-context path; the literal `[idx]` stands for the
/// current row of a `per-row` list (`"move": "pokemon.moves[idx]"`).
#[derive(Debug, Clone, Deserialize)]
pub struct ChildRecord {
    pub id: String,
    pub instances: Instances,
    #[serde(default)]
    pub props: BTreeMap<String, String>,
}

/// `"static"` | `"per-row:<list path>"` (the list's context path, not the
/// client loop member).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Instances {
    Static,
    PerRow(String),
}

impl<'de> Deserialize<'de> for Instances {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        match s.as_str() {
            "static" => Ok(Instances::Static),
            _ => s
                .strip_prefix("per-row:")
                .filter(|p| !p.is_empty())
                .map(|p| Instances::PerRow(p.to_string()))
                .ok_or_else(|| {
                    serde::de::Error::custom(format!(
                        "instances: want \"static\" or \"per-row:<list path>\", got {s:?}"
                    ))
                }),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Assets {
    pub runtime: String,
    #[serde(default)]
    pub react: Option<String>,
}

/// A validated manifest plus every component's template source, read once.
#[derive(Debug)]
pub struct Loaded {
    pub manifest: Manifest,
    /// component id → template source.
    pub templates: BTreeMap<String, String>,
    pub dist_dir: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("read {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("parse {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("manifest version {0} unsupported (want 1)")]
    Version(u32),
    #[error("route {route}: unknown component {component}")]
    UnknownComponent { route: String, component: String },
    #[error("component {component}: missing file {path}")]
    MissingFile { component: String, path: PathBuf },
    #[error(
        "component {component}: child {child} job {job} input root {root} is not in the child's `props` map"
    )]
    UncoveredInput {
        component: String,
        child: String,
        job: String,
        root: String,
    },
}

/// Root segment of a job input path: text before the first `.` or `[`, with a
/// leading `props.` stripped (`"props.item.price"` → `"item"`).
pub(crate) fn input_root(input: &str) -> &str {
    let s = input.strip_prefix("props.").unwrap_or(input);
    s.split(['.', '[']).next().unwrap_or(s)
}

impl Manifest {
    /// Read and validate `<dist_dir>/manifest.json`. Fails closed: the first
    /// broken reference is returned as an `Err` naming the path/id.
    pub fn load(dist_dir: &Path) -> Result<Loaded, ManifestError> {
        let mpath = dist_dir.join("manifest.json");
        let raw = std::fs::read(&mpath).map_err(|source| ManifestError::Read {
            path: mpath.clone(),
            source,
        })?;
        let manifest: Manifest =
            serde_json::from_slice(&raw).map_err(|source| ManifestError::Parse {
                path: mpath.clone(),
                source,
            })?;
        if manifest.version != 1 {
            return Err(ManifestError::Version(manifest.version));
        }
        let must_exist = |component: &str, rel: &str| -> Result<PathBuf, ManifestError> {
            let p = dist_dir.join(rel);
            if p.is_file() {
                Ok(p)
            } else {
                Err(ManifestError::MissingFile {
                    component: component.into(),
                    path: p,
                })
            }
        };
        for r in &manifest.routes {
            for c in &r.chain {
                if !manifest.components.contains_key(c) {
                    return Err(ManifestError::UnknownComponent {
                        route: r.id.clone(),
                        component: c.clone(),
                    });
                }
            }
        }
        let mut templates = BTreeMap::new();
        for (id, c) in &manifest.components {
            let tp = must_exist(id, &c.template)?;
            let src = std::fs::read_to_string(&tp)
                .map_err(|source| ManifestError::Read { path: tp, source })?;
            templates.insert(id.clone(), src);
            if let Some(cl) = &c.client {
                must_exist(id, cl)?;
            }
            for ch in &c.children {
                let Some(child) = manifest.components.get(&ch.id) else {
                    return Err(ManifestError::UnknownComponent {
                        route: id.clone(),
                        component: ch.id.clone(),
                    });
                };
                for j in &child.jobs {
                    for i in &j.inputs {
                        let root = input_root(i);
                        if !ch.props.contains_key(root) {
                            return Err(ManifestError::UncoveredInput {
                                component: id.clone(),
                                child: ch.id.clone(),
                                job: j.id.clone(),
                                root: root.into(),
                            });
                        }
                    }
                }
            }
        }
        must_exist("assets", &manifest.assets.runtime)?;
        if let Some(r) = &manifest.assets.react {
            must_exist("assets", r)?;
        }
        Ok(Loaded {
            manifest,
            templates,
            dist_dir: dist_dir.to_path_buf(),
        })
    }
}
