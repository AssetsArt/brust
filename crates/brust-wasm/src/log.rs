//! A WARN-and-up `tracing` subscriber printing one line per event to the console (no time:
//! workerd stamps its log lines). ERROR → `console.error`, WARN → `console.warn`.
use std::fmt::Write;

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};

struct Console;

struct Line(String);

impl Visit for Line {
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        if f.name() == "message" {
            let _ = write!(self.0, " {v:?}");
        } else {
            let _ = write!(self.0, " {}={v:?}", f.name());
        }
    }

    fn record_str(&mut self, f: &Field, v: &str) {
        if f.name() == "message" {
            let _ = write!(self.0, " {v}");
        } else {
            let _ = write!(self.0, " {}={v}", f.name());
        }
    }
}

impl Subscriber for Console {
    fn enabled(&self, m: &Metadata<'_>) -> bool {
        *m.level() <= Level::WARN
    }

    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _: &Id, _: &Record<'_>) {}

    fn record_follows_from(&self, _: &Id, _: &Id) {}

    fn event(&self, e: &Event<'_>) {
        let m = e.metadata();
        let mut line = Line(format!("{} {}:", m.level(), m.target()));
        e.record(&mut line);
        let s = wasm_bindgen::JsValue::from(line.0);
        if *m.level() == Level::ERROR {
            web_sys::console::error_1(&s);
        } else {
            web_sys::console::warn_1(&s);
        }
    }

    fn enter(&self, _: &Id) {}

    fn exit(&self, _: &Id) {}
}

/// Install the subscriber (once per isolate; a second call is a no-op).
pub fn init() {
    let _ = tracing::subscriber::set_global_default(Console);
}
