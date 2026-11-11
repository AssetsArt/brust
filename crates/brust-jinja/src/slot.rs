//! F519: the `<Dynamic>` slot. The compiler prints `{{ brust_dynamic(<ref>, <props>) }}`; the server
//! puts a [`SlotHost`] in the render context under [`SLOT_KEY`] and the function hands the call to it.
//! Without one in scope (the compiler's dual-evaluation harness, a renderer that has no runtime
//! components) the slot prints nothing.
use std::sync::Arc;

use minijinja::State;
use minijinja::value::{Object, Value};

/// The context key the server's slot renderer sits under. The overlay beats loader data, so a
/// loader key of the same name never reaches the function.
pub const SLOT_KEY: &str = "__brust_slots";

/// What renders one slot: `reference` and `props` as the template evaluated them. Returns the
/// HTML to print (already safe), or `""`.
pub trait SlotRender: Send + Sync + std::fmt::Debug + 'static {
    fn render_slot(&self, reference: &Value, props: &Value) -> String;
}

/// The context value under [`SLOT_KEY`]: an opaque object that only `brust_dynamic` reads.
#[derive(Debug)]
pub struct SlotHost(pub Arc<dyn SlotRender>);

impl Object for SlotHost {}

impl SlotHost {
    /// The context value for `r`.
    pub fn value(r: Arc<dyn SlotRender>) -> Value {
        Value::from_object(SlotHost(r))
    }
}

/// `brust_dynamic(ref, props)`.
pub(crate) fn brust_dynamic(state: &State, reference: Value, props: Option<Value>) -> Value {
    let props = props.unwrap_or(Value::UNDEFINED);
    let html = state
        .lookup(SLOT_KEY)
        .and_then(|v| v.downcast_object::<SlotHost>())
        .map(|h| h.0.render_slot(&reference, &props))
        .unwrap_or_default();
    Value::from_safe_string(html)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Echo;

    impl SlotRender for Echo {
        fn render_slot(&self, reference: &Value, props: &Value) -> String {
            format!("<{reference}:{}>", props.get_attr("t").unwrap_or_default())
        }
    }

    fn env() -> minijinja::Environment<'static> {
        let mut env = minijinja::Environment::new();
        crate::register(&mut env);
        env
    }

    #[test]
    fn without_a_host_in_scope_the_slot_prints_nothing() {
        let env = env();
        let out = env
            .render_str("[{{ brust_dynamic('a', {'t': 1}) }}]", ())
            .unwrap();
        assert_eq!(out, "[]");
    }

    #[test]
    fn the_host_in_scope_renders_the_slot_with_its_ref_and_props() {
        let env = env();
        let ctx =
            minijinja::context! { __brust_slots => SlotHost::value(Arc::new(Echo)), r => "x" };
        let out = env
            .render_str(
                "{% for i in [1, 2] %}{{ brust_dynamic(r, {'t': i}) }}{% endfor %}{{ brust_dynamic('y') }}",
                ctx,
            )
            .unwrap();
        assert_eq!(out, "<x:1><x:2><y:>");
    }
}
