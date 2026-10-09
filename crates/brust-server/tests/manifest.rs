use brust_server::manifest::{Instances, Manifest, ManifestError, Tier};
use std::path::{Path, PathBuf};

fn fx() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let dst = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &dst);
        } else {
            std::fs::copy(entry.path(), dst).unwrap();
        }
    }
}

#[test]
fn loads_fixture_and_reads_every_template() {
    let l = Manifest::load(&fx()).unwrap();
    assert_eq!(l.manifest.routes.len(), 6);
    assert_eq!(l.manifest.components["detailPage_c3"].tier, Tier::Native);
    assert_eq!(
        l.manifest.components["detailPage_c3"].children[0].instances,
        Instances::PerRow("pokemon.moves".into())
    );
    assert!(l.templates["appLayout_a1"].contains("__outlet"));
}

#[test]
fn missing_template_fails_with_path() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::copy(fx().join("manifest.json"), tmp.path().join("manifest.json")).unwrap();
    let err = Manifest::load(tmp.path()).unwrap_err();
    match err {
        ManifestError::MissingFile { component, path } => {
            assert_eq!(component, "appLayout_a1");
            assert!(path.ends_with("jinja/appLayout_a1.jinja"));
        }
        e => panic!("{e}"),
    }
}

#[test]
fn wrong_version_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("manifest.json"),
        r#"{"version":2,"routes":[],"components":{},"assets":{"runtime":"client/runtime.js"},"jobs_module":"jobs.js"}"#,
    )
    .unwrap();
    match Manifest::load(tmp.path()).unwrap_err() {
        ManifestError::Version(v) => assert_eq!(v, 2),
        e => panic!("{e}"),
    }
}

#[test]
fn uncovered_child_input_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    copy_dir(&fx(), tmp.path());
    let mpath = tmp.path().join("manifest.json");
    let mut m: serde_json::Value = serde_json::from_slice(&std::fs::read(&mpath).unwrap()).unwrap();
    let child = &mut m["components"]["detailPage_c3"]["children"][0];
    assert!(child.as_object_mut().unwrap().remove("props").is_some());
    std::fs::write(&mpath, serde_json::to_vec(&m).unwrap()).unwrap();
    match Manifest::load(tmp.path()).unwrap_err() {
        ManifestError::UncoveredInput {
            component,
            child,
            job,
            root,
        } => {
            assert_eq!(component, "detailPage_c3");
            assert_eq!(child, "moveCard_d4");
            assert_eq!(job, "j0");
            assert_eq!(root, "move");
        }
        e => panic!("{e}"),
    }
}
