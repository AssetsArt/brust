//! F204: the child-instance slot dict key the compiler prints (`__<component id>_<ordinal>`) is never loader-writable,
//! whatever the file name. The keys are built from the real `component_id`, then run through brust-core's loader merge.
use brust_compiler::ir::{component_id, named_component_id};
use brust_core::pipeline::merge_loader_data;
use brust_jinja::ctx::{MapInner, Node};

fn survives(key: &str) -> bool {
    let mut ctx = MapInner::new();
    merge_loader_data(
        &mut ctx,
        Node::from(serde_json::json!({ key: "loader" })),
        "r1",
    );
    ctx.contains_key(key)
}

#[test]
fn an_instance_dict_key_built_from_any_component_id_is_reserved() {
    let ids = [
        component_id("pages/field.tsx"),
        component_id("components/ui/accordion-item.tsx"),
        component_id("pages/หน้า.tsx"), // no ASCII alphanumerics: the id is `_<hash>`
        component_id("pages/_.tsx"),
        named_component_id("components/ui/menu.tsx", "MenuItem"),
        named_component_id("pages/หน้า.tsx", "ส่วน"),
    ];
    assert!(
        ids.iter().any(|id| id.starts_with('_')),
        "{ids:?}: need an empty-name id"
    );
    for id in ids {
        for ordinal in [1, 2, 17] {
            let key = format!("__{id}_{ordinal}");
            assert!(!survives(&key), "{key} must be dropped from loader data");
        }
    }
}

#[test]
fn lookalikes_stay_loader_data() {
    for key in [
        "__typename",
        "__a_1",
        "__proto__",
        "__field_603ad356",
        "__field_603ad356_x",
        "__field_603AD356_1",
    ] {
        assert!(survives(key), "{key} is the loader's");
    }
}
