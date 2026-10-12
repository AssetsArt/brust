//! `dist/manifest.json` (spec §3 S6): the only contract between `brust build`
//! and the server. Read once at boot; every reference it makes (templates,
//! client chunks, assets, chain components, child job inputs) is checked here
//! so a bad manifest fails `start` instead of a request (spec §7).

use std::collections::BTreeMap;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::path::Path;
use std::path::PathBuf;

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
    /// M3-F C3: project-relative store modules the component reads at render (sorted, unique).
    /// The server only asks whether a route's chain has any (the worker touches them).
    #[serde(default)]
    pub stores: Vec<String>,
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
    /// The context names the job's result fills, copied from the IR
    /// (`_s1`… for precompute, `_ssr_<childId>[_<k>]` for ssr). Empty = an
    /// older manifest: a precompute result object is spread into the overlay
    /// and an ssr result lands at `_ssr_<componentId>`.
    #[serde(default)]
    pub outputs: Vec<String>,
    /// `ssr` only: the react component the worker renders
    /// (`jobs[target].ssr(inputs)`); a react child's id while the job sits in
    /// its parent's `jobs[]`. Passed through as `JobCall.target`.
    #[serde(default)]
    pub target: Option<String>,
    /// v2 extension (not in the ruling; see the port doc): the `target`'s
    /// props as `{ childProp: parent context path }`, `[idx]` = the current
    /// row of `per_instance`. When set, the worker receives this object as
    /// `inputs` (what `jobs[target].ssr` needs) and the job key hashes it.
    #[serde(default)]
    pub props: Option<BTreeMap<String, String>>,
}

/// The `inputs` entry meaning "all of the component's props" (S6 amendment).
pub const ALL_PROPS: &str = "*";

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
        // Ruling 24e8bf17: the string form is the only wire form; anything
        // else (e.g. the withdrawn `{k, per_instance}` object) gets the same message.
        let s = String::deserialize(d).map_err(|e| {
            serde::de::Error::custom(format!(
                "instances: want \"static\" or \"per-row:<list path>\" ({e})"
            ))
        })?;
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
    #[error("component {component}: job {job}: {reason}")]
    BadJob {
        component: String,
        job: String,
        reason: String,
    },
    #[error("component {component}: bad path {path:?} in {field}: {reason}")]
    BadPath {
        component: String,
        field: String,
        path: String,
        reason: String,
    },
}

/// Boot-time parse of every path the request pipeline evaluates, so a
/// malformed one fails `load` instead of 500-ing every request.
fn check_paths(id: &str, c: &ComponentRecord) -> Result<(), ManifestError> {
    let bad = |field: String, path: &str, reason: String| ManifestError::BadPath {
        component: id.into(),
        field,
        path: path.into(),
        reason,
    };
    let parse = |field: String, path: &str| {
        crate::inputs::Path::parse(path).map_err(|reason| bad(field, path, reason))
    };
    let has_idx = |p: &crate::inputs::Path| {
        p.segs()
            .iter()
            .any(|s| matches!(s, crate::inputs::Seg::Idx))
    };
    let bad_job = |job: &str, reason: String| ManifestError::BadJob {
        component: id.into(),
        job: job.into(),
        reason,
    };
    for j in &c.jobs {
        for o in &j.outputs {
            if !is_ident(o) {
                return Err(bad_job(&j.id, format!("output {o:?} is not an identifier")));
            }
        }
        if j.per_instance.is_some() && j.outputs.len() != 1 {
            return Err(bad_job(
                &j.id,
                format!(
                    "a per_instance job needs exactly one output (got {})",
                    j.outputs.len()
                ),
            ));
        }
        if j.kind == JobKind::Ssr && j.outputs.len() > 1 {
            return Err(bad_job(
                &j.id,
                format!("an ssr job fills one output (got {})", j.outputs.len()),
            ));
        }
        if let Some(props) = &j.props {
            for (prop, src) in props {
                let field = format!("job {} props.{prop}", j.id);
                if has_idx(&parse(field.clone(), src)?) && j.per_instance.is_none() {
                    return Err(bad(field, src, "[idx] needs per_instance".into()));
                }
            }
        }
        for i in j.inputs.iter().filter(|i| i.as_str() != ALL_PROPS) {
            if has_idx(&parse(format!("job {} inputs", j.id), i)?) {
                return Err(bad(
                    format!("job {} inputs", j.id),
                    i,
                    "[idx] is only valid in a per-row child's props".into(),
                ));
            }
        }
        if let Some(k) = &j.cache.key {
            parse(format!("job {} cache.key", j.id), k)?;
        }
        if let Some(p) = &j.per_instance {
            parse(format!("job {} per_instance", j.id), p)?;
        }
    }
    for ch in &c.children {
        let per_row = match &ch.instances {
            Instances::Static => false,
            Instances::PerRow(list) => {
                parse(format!("child {} instances", ch.id), list)?;
                true
            }
        };
        for (prop, src) in &ch.props {
            let field = format!("child {} props.{prop}", ch.id);
            if has_idx(&parse(field.clone(), src)?) && !per_row {
                return Err(bad(field, src, "[idx] needs a per-row instance".into()));
            }
        }
    }
    Ok(())
}

/// `[A-Za-z_][A-Za-z0-9_]*`: a name a template can read.
fn is_ident(s: &str) -> bool {
    let mut b = s.bytes();
    matches!(b.next(), Some(c) if c.is_ascii_alphabetic() || c == b'_')
        && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Root segment of a job input path: text before the first `.` or `[`, with a
/// leading `props.` stripped (`"props.item.price"` → `"item"`).
pub(crate) fn input_root(input: &str) -> &str {
    let s = input.strip_prefix("props.").unwrap_or(input);
    s.split(['.', '[']).next().unwrap_or(s)
}

/// What a file reference in the manifest is, for [`walk`]'s file callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileUse {
    /// `components[id].template`: its source is returned and kept.
    Template,
    /// `components[id].client`: only its existence matters.
    Client,
    /// `assets.runtime` / `assets.react`.
    Asset,
}

/// [`walk`]'s file callback: `(component, rel path, use)` → a template's source, or nothing.
type FileFn<'a> = dyn FnMut(&str, &str, FileUse) -> Result<Option<String>, ManifestError> + 'a;

/// Every reference check of a parsed manifest, in `load`'s order (version, route chains, then per
/// component: paths, job targets, the template, the client file, the children's job inputs; then
/// the assets). `file(component, rel, use)` resolves each file reference: `Ok(Some(source))` for a
/// template keeps it; an `Err` stops the walk.
fn walk(
    manifest: Manifest,
    file: &mut FileFn<'_>,
) -> Result<(Manifest, BTreeMap<String, String>), ManifestError> {
    if manifest.version != 1 {
        return Err(ManifestError::Version(manifest.version));
    }
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
        check_paths(id, c)?;
        for j in &c.jobs {
            if let Some(t) = &j.target
                && !manifest.components.contains_key(t)
            {
                return Err(ManifestError::BadJob {
                    component: id.clone(),
                    job: j.id.clone(),
                    reason: format!("target {t:?} is not a known component"),
                });
            }
        }
        if let Some(src) = file(id, &c.template, FileUse::Template)? {
            templates.insert(id.clone(), src);
        }
        if let Some(cl) = &c.client {
            file(id, cl, FileUse::Client)?;
        }
        for ch in &c.children {
            let Some(child) = manifest.components.get(&ch.id) else {
                return Err(ManifestError::UnknownComponent {
                    route: id.clone(),
                    component: ch.id.clone(),
                });
            };
            for j in &child.jobs {
                // `*` is the child's whole props object: covered by definition.
                for i in j.inputs.iter().filter(|i| i.as_str() != ALL_PROPS) {
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
    file("assets", &manifest.assets.runtime, FileUse::Asset)?;
    if let Some(r) = &manifest.assets.react {
        file("assets", r, FileUse::Asset)?;
    }
    Ok((manifest, templates))
}

impl Manifest {
    /// Read and validate `<dist_dir>/manifest.json`. Fails closed: the first
    /// broken reference is returned as an `Err` naming the path/id. Not on
    /// wasm32-unknown-unknown (no filesystem, R9a): a Workers host uses [`Manifest::from_parts`].
    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
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
        let (manifest, templates) = walk(manifest, &mut |component, rel, used| {
            let p = must_exist(component, rel)?;
            if used != FileUse::Template {
                return Ok(None);
            }
            std::fs::read_to_string(&p)
                .map(Some)
                .map_err(|source| ManifestError::Read { path: p, source })
        })?;
        Ok(Loaded {
            manifest,
            templates,
            dist_dir: dist_dir.to_path_buf(),
        })
    }

    /// The manifest from memory (M4-CF-3; lane-1 R5): `manifest_json` is `manifest.json`'s text,
    /// `files` the template sources keyed by `components[id].template`. The same parse, version
    /// and reference checks as [`Manifest::load`], in its order; a missing template is
    /// `MissingFile` with the template's rel path. Client and asset files are not checked (on
    /// Workers, Static Assets owns them). `dist_dir` is empty.
    pub fn from_parts(
        manifest_json: &str,
        files: &BTreeMap<String, String>,
    ) -> Result<Loaded, ManifestError> {
        let manifest: Manifest =
            serde_json::from_str(manifest_json).map_err(|source| ManifestError::Parse {
                path: PathBuf::from("manifest.json"),
                source,
            })?;
        let (manifest, templates) = walk(manifest, &mut |component, rel, used| match used {
            FileUse::Template => {
                files
                    .get(rel)
                    .cloned()
                    .map(Some)
                    .ok_or_else(|| ManifestError::MissingFile {
                        component: component.into(),
                        path: PathBuf::from(rel),
                    })
            }
            FileUse::Client | FileUse::Asset => Ok(None),
        })?;
        Ok(Loaded {
            manifest,
            templates,
            dist_dir: PathBuf::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dist() -> PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../brust-server/tests/fixtures/dist")
    }

    /// The fixture's `manifest.json` text and every `jinja/<file>` keyed by its template rel path.
    fn parts() -> (serde_json::Value, BTreeMap<String, String>) {
        let d = dist();
        let m = serde_json::from_slice(&std::fs::read(d.join("manifest.json")).unwrap()).unwrap();
        let mut files = BTreeMap::new();
        for e in std::fs::read_dir(d.join("jinja")).unwrap() {
            let name = e.unwrap().file_name().into_string().unwrap();
            let src = std::fs::read_to_string(d.join("jinja").join(&name)).unwrap();
            files.insert(format!("jinja/{name}"), src);
        }
        (m, files)
    }

    #[test]
    fn from_parts_equals_load_on_the_fixture_dist() {
        let a = Manifest::load(&dist()).unwrap();
        let (m, files) = parts();
        let b = Manifest::from_parts(&m.to_string(), &files).unwrap();
        assert_eq!(format!("{:?}", a.manifest), format!("{:?}", b.manifest));
        assert_eq!(a.templates, b.templates);
        assert_eq!(b.dist_dir, PathBuf::new());
    }

    #[test]
    fn from_parts_missing_template_names_component() {
        let (m, mut files) = parts();
        files.remove("jinja/homePage_b2.jinja");
        let e = Manifest::from_parts(&m.to_string(), &files).unwrap_err();
        let ManifestError::MissingFile { component, path } = e else {
            panic!("want MissingFile, got {e:?}");
        };
        assert_eq!(
            (component.as_str(), path),
            ("homePage_b2", PathBuf::from("jinja/homePage_b2.jinja"))
        );
    }

    #[test]
    fn from_parts_ignores_client_and_assets_files() {
        let (mut m, files) = parts();
        m["assets"]["runtime"] = "client/nope.js".into();
        m["assets"]["react"] = "client/nope-react.js".into();
        for c in m["components"].as_object_mut().unwrap().values_mut() {
            c["client"] = "client/nope-island.js".into();
        }
        assert!(Manifest::from_parts(&m.to_string(), &files).is_ok());
    }

    #[test]
    fn from_parts_bad_version() {
        let (mut m, files) = parts();
        m["version"] = 2.into();
        let e = Manifest::from_parts(&m.to_string(), &files).unwrap_err();
        assert!(matches!(e, ManifestError::Version(2)), "{e:?}");
    }

    #[test]
    fn from_parts_bad_json() {
        let e = Manifest::from_parts("{not json", &BTreeMap::new()).unwrap_err();
        let ManifestError::Parse { path, .. } = e else {
            panic!("want Parse, got {e:?}");
        };
        assert_eq!(path, PathBuf::from("manifest.json"));
    }
}
