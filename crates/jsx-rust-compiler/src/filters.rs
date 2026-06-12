//! minijinja filters that are part of the COMPILER'S EMISSION CONTRACT: the
//! compiler emits `{{ … | json_attr }}` / `{{ … | style_safe }}` references,
//! so it owns the single definition. Every render environment (brust-core's
//! boot + dynamic tiers, the golden-render test harness) registers these —
//! never a local copy, so the emitted reference and the runtime behavior
//! cannot drift.

/// Serialize a value to JSON, then HTML-entity-encode it for safe placement in a
/// double-quoted attribute (e.g. `x-props`). Mirrors the islands
/// `entityEncode(JSON.stringify(...))` path. minijinja's built-in `tojson` is
/// `<script>`-oriented (safe-marked, does NOT escape `"`) so it is WRONG for an
/// HTML attribute — hence this filter.
pub fn json_attr(value: minijinja::Value) -> Result<String, minijinja::Error> {
    let json = serde_json::to_string(&value).map_err(|e| {
        minijinja::Error::new(
            minijinja::ErrorKind::InvalidOperation,
            "x-props JSON serialization failed",
        )
        .with_source(e)
    })?;
    Ok(json
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;"))
}

/// CSS-safe interpolation for dynamic `<style>` text (`<BrustPage head>` style
/// entries). HTML-escaping (`| e`) would corrupt CSS (`>` child combinators);
/// raw output would allow a `</style>` breakout. Scrubbing every `</` to `<\/`
/// kills the breakout (the parser only leaves CSS on `</style`) while staying
/// valid inside CSS strings — and `</` is never valid CSS syntax outside
/// strings. Tag-name case is irrelevant: the scrub targets the `</` sequence
/// itself. This is a breakout GUARD, not a CSS sanitizer — dynamic style text
/// is platform-authored (per-tenant tokens), not end-user input. Output is
/// emitted raw (brust runs minijinja with `AutoEscape::None`).
pub fn style_safe(value: minijinja::Value) -> String {
    // `Value` Display renders undefined as empty — mirrors Chainable behavior.
    value.to_string().replace("</", "<\\/")
}
