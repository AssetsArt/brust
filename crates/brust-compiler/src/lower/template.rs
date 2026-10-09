//! Template backend (spec §6.1, §7.2): the placed template as minijinja with
//! the directive attributes of `packages/runtime-dom/README.md`.
//!
//! One walk prints the jinja and records the client members the directives
//! name (`_cN`, `_lN`, `_kN`, `_pN`), so the template and the chunk agree on
//! numbering by construction. Child components are inlined by a nested walk
//! over the child's own IR (its members belong to the child's chunk, so they
//! are numbered the same in every instance).
//!
//! Render context contract: props are top-level variables (`_props` is the
//! whole props object), precompute slots `_sN`, island SSR outputs
//! `_ssr_<childId>`, and an inlined child instance's job output under
//! `__<childId>_<k>` (an object of its slots, indexed per item of the parent's
//! enclosing lists).
use super::common::{Facts, raw_of};
use super::server_expr::{JinjaCtx, UNDEFINED, jinja_string, to_jinja};
use super::{LowerCtx, Member, MemberDef, Paint};
use crate::ir::{
    Attr, ComponentIR, Diagnostic, Expr, IdentKind, JobKind, Node, RawExpr, RawKind, ServerExpr,
    Tier,
};
use brust_jinja::{
    attr_name, escape_attr, is_boolean_attr, is_refused_attr, is_url_attr, safe_url,
};
use std::cell::Cell;
use std::collections::{BTreeSet, HashMap};

const VOID: &[&str] = &[
    "img", "input", "br", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track",
    "wbr",
];

/// What a prop of an inlined child reads in the parent's template.
#[derive(Clone, Debug)]
pub enum PropBinding {
    /// A jinja expression in the parent's scope.
    Expr(String),
    /// JSX children: markup printed in the parent's scope.
    Markup(String),
}

/// How an instance is embedded: `None` for the component itself.
pub struct Inline {
    pub props: HashMap<String, PropBinding>,
    /// `x-props-bind` value when the parent links this instance.
    pub bind: Option<String>,
    /// Template variable of this instance's job output (`__<id>_<k>[…]`).
    pub slots: String,
    /// Suffix for this instance's seed and derived variables.
    pub suffix: String,
}

pub struct TemplateOut {
    pub jinja: String,
    pub members: Vec<Member>,
    pub diagnostics: Vec<Diagnostic>,
}

struct Frame {
    item: String,
    index: Option<String>,
    /// `{% set _iN = loop.index0 %}` variable of this loop.
    var: String,
    /// The row carries `x-for`: loop reads inside it get directives.
    directive: bool,
}

pub struct Printer<'a, 'c> {
    ctx: &'c LowerCtx<'a>,
    f: Facts<'c>,
    inline: Option<Inline>,
    loop_var: &'c Cell<u32>,
    out: String,
    members: Vec<Member>,
    counts: HashMap<&'static str, u32>,
    frames: Vec<Frame>,
    diagnostics: Vec<Diagnostic>,
    /// Prop roots the members read: they are seeded through `x-props`.
    prop_reads: BTreeSet<String>,
    prop_seen: std::cell::RefCell<BTreeSet<String>>,
    /// Host attributes of an inlined instance (`x-data`, `x-props-bind`).
    inline_host: Option<(String, Option<String>)>,
    /// Instances inlined so far, by child id.
    instances: HashMap<String, u32>,
    /// SSR outputs used so far, by child id.
    ssr: HashMap<String, u32>,
    native: bool,
    /// Printing the zero-row `x-for` template: it is cloned and re-bound by
    /// the runtime, so no value is evaluated (there is no item).
    blank: bool,
}

impl<'a, 'c> Printer<'a, 'c> {
    pub fn new(
        ir: &'c ComponentIR,
        ctx: &'c LowerCtx<'a>,
        inline: Option<Inline>,
        loop_var: &'c Cell<u32>,
    ) -> Option<Self> {
        let structural = ir.structural.as_deref()?;
        Some(Printer {
            ctx,
            f: Facts::new(ir, structural),
            native: !matches!(ir.tier, Tier::Static) || (ctx.linked)(&ir.id),
            inline,
            loop_var,
            out: String::new(),
            members: Vec::new(),
            counts: HashMap::new(),
            frames: Vec::new(),
            diagnostics: Vec::new(),
            prop_reads: BTreeSet::new(),
            prop_seen: Default::default(),
            inline_host: None,
            instances: HashMap::new(),
            ssr: HashMap::new(),
            blank: false,
        })
    }

    pub fn print(mut self) -> TemplateOut {
        let ir = self.f.ir;
        if self.inline.is_none() {
            self.out
                .push_str(&format!("{{# brust v2 · {} · do not edit #}}\n", ir.id));
        }
        self.preamble();
        let structural = self.f.structural;
        self.node(&ir.template, &structural.template, true);
        TemplateOut {
            jinja: self.out,
            members: self.members,
            diagnostics: self.diagnostics,
        }
    }

    fn next(&mut self, prefix: &'static str) -> String {
        let n = self.counts.entry(prefix).or_insert(0);
        *n += 1;
        format!("{prefix}{n}")
    }

    fn suffix(&self) -> &str {
        self.inline.as_ref().map_or("", |i| i.suffix.as_str())
    }

    /// Seed and derived `set`s in declaration (source) order.
    fn preamble(&mut self) {
        let ir = self.f.ir;
        let mut decls: Vec<(u32, String)> = Vec::new();
        for (i, s) in ir.state.iter().enumerate() {
            let loc = self.f.structural.state[i]
                .init
                .raw_loc()
                .unwrap_or_default();
            let value = self.value(&s.init);
            decls.push((
                loc,
                format!("{{% set {}{} = {value} %}}", s.name, self.suffix()),
            ));
        }
        for (i, d) in ir.derived.iter().enumerate() {
            if !matches!(d.expr, Expr::Server(_) | Expr::Precomputed { .. }) {
                continue;
            }
            let loc = self.f.structural.derived[i]
                .expr
                .raw_loc()
                .unwrap_or_default();
            let value = self.value(&d.expr);
            decls.push((
                loc,
                format!("{{% set {} = {value} %}}", self.derived_var(&d.name)),
            ));
        }
        decls.sort_by_key(|d| d.0);
        for (_, line) in decls {
            self.out.push_str(&line);
            self.out.push('\n');
        }
    }

    /// The server-seeded `useId` value `k` of this component instance.
    fn id_ref(&self, k: usize) -> String {
        if self.blank {
            return UNDEFINED.into();
        }
        self.slot_ref(&format!("_id{k}"), false)
    }

    fn derived_var(&self, name: &str) -> String {
        let i = self
            .f
            .ir
            .derived
            .iter()
            .position(|d| d.name == name)
            .unwrap_or(0);
        format!("_d{}{}", i + 1, self.suffix())
    }

    fn names(&self) -> impl Fn(&str, &IdentKind) -> Option<String> + '_ {
        move |name: &str, kind: &IdentKind| match kind {
            IdentKind::Prop => {
                let base = match &self.inline {
                    None if name == "*" => "_props".into(),
                    None => name.to_string(),
                    Some(i) => match i.props.get(name) {
                        Some(PropBinding::Expr(e)) => format!("({e})"),
                        _ => UNDEFINED.into(),
                    },
                };
                // A destructuring default applies when the prop is undefined.
                Some(match self.f.prop_defaults.get(name) {
                    Some(d) => {
                        let plain = JinjaCtx::plain();
                        let dj = to_jinja(&ServerExpr(d.clone()), &plain);
                        format!("({base} if {base} is defined else {dj})")
                    }
                    None => base,
                })
            }
            IdentKind::State => Some(format!("{name}{}", self.suffix())),
            // An inlined child's loop variables carry the instance suffix in
            // the template, so a parent expression substituted for a prop
            // (`item.title`) is never captured by the child's own `item`.
            IdentKind::LoopBinding if self.inline.is_some() => {
                Some(format!("{name}{}", self.suffix()))
            }
            IdentKind::Local => Some(if self.f.derived.contains_key(name) {
                self.derived_var(name)
            } else if let Some(k) = self.f.ir.id_bindings.iter().position(|i| i == name) {
                // Read the server-seeded value directly: no template variable to shadow a prop.
                self.id_ref(k)
            } else {
                UNDEFINED.into()
            }),
            _ => None,
        }
    }

    fn jinja(&self, e: &RawExpr) -> String {
        if self.blank {
            return UNDEFINED.into();
        }
        let names = self.names();
        to_jinja(
            &ServerExpr(e.clone()),
            &JinjaCtx {
                in_loop: None,
                props_prefix: None,
                names: &names,
            },
        )
    }

    /// A placed value as a jinja expression.
    fn value(&self, e: &Expr) -> String {
        if self.blank {
            return UNDEFINED.into();
        }
        match e {
            Expr::Server(ServerExpr(r)) => self.jinja(r),
            Expr::Precomputed { slot, per_item, .. } => self.slot_ref(slot, per_item.is_some()),
            _ => UNDEFINED.into(),
        }
    }

    fn slot_ref(&self, slot: &str, per_item: bool) -> String {
        let base = match &self.inline {
            None => slot.to_string(),
            Some(i) => format!("{}[{}]", i.slots, jinja_string(slot)),
        };
        if !per_item {
            return base;
        }
        let idx: String = self.frames.iter().map(|f| format!("[{}]", f.var)).collect();
        format!("{base}{idx}")
    }

    fn scope(&self) -> Vec<String> {
        let mut s = Vec::new();
        for f in &self.frames {
            s.push(f.item.clone());
            s.extend(f.index.clone());
        }
        s
    }

    /// Whether a painted value changes after first paint (needs a directive),
    /// and the loop bindings it reads.
    fn reactive(&self, raw: Option<&RawExpr>, placed: &Expr) -> Option<Vec<String>> {
        let raw = raw?;
        // `{children}` is markup the parent printed; it has no client value.
        if matches!(&raw.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children")
        {
            return None;
        }
        let deps = self.f.deps(raw, &self.scope());
        let in_row = self.frames.iter().any(|f| f.directive);
        let sd = !deps.state.is_empty()
            || matches!(
                placed,
                Expr::Precomputed {
                    state_dependent: true,
                    ..
                }
            );
        // Only a Server (template-subset) value is client-computable: a
        // props-only precomputed slot never appears in the chunk (§7.1).
        let client_ok = matches!(placed, Expr::Server(_)) && !self.reaches_props_only_slot(raw);
        let loop_read = in_row && !deps.loop_bindings.is_empty() && client_ok;
        // Props are a signal in the chunk (a linked child's change after
        // first paint): in a native component a prop read is reactive too —
        // unless it also reads a loop binding outside an x-for row (no scope).
        let prop_read =
            !deps.props.is_empty() && client_ok && (deps.loop_bindings.is_empty() || in_row);
        if !(self.native && (sd || loop_read || prop_read)) {
            return None;
        }
        // Seeded through x-props so the chunk starts from the painted value.
        // (Interior mutability: `reactive` is called on `&self`.)
        // Exact paths: a painted `user.name` seeds `{user: {name}}`, never
        // the whole `user` object.
        self.seen_props(&deps.props);
        // Bindings in loop order.
        let mut b = Vec::new();
        for f in &self.frames {
            if deps.loop_bindings.contains(&f.item) {
                b.push(f.item.clone());
            }
            if let Some(i) = &f.index
                && deps.loop_bindings.contains(i)
            {
                b.push(i.clone());
            }
        }
        Some(b)
    }

    /// `raw` reads (through derived values) a props-only precomputed slot,
    /// which only the job can compute.
    fn reaches_props_only_slot(&self, raw: &RawExpr) -> bool {
        self.f.reach(&[raw]).iter().any(|n| {
            self.f.ir.derived.iter().any(|d| {
                &d.name == n
                    && matches!(
                        d.expr,
                        Expr::Precomputed {
                            state_dependent: false,
                            ..
                        }
                    )
            })
        })
    }

    fn seen_props(&self, roots: &BTreeSet<String>) {
        self.prop_seen.borrow_mut().extend(roots.iter().cloned());
    }

    /// Registers a value member; returns the directive value.
    fn value_member(&mut self, raw: &RawExpr, bindings: Vec<String>, paint: Paint) -> String {
        let name = self.next("_c");
        self.push_member(&name, raw, bindings.clone(), false, paint);
        directive(&name, &bindings)
    }

    fn push_member(
        &mut self,
        name: &str,
        raw: &RawExpr,
        bindings: Vec<String>,
        negate: bool,
        paint: Paint,
    ) {
        self.members.push(Member {
            name: name.to_string(),
            def: MemberDef::Value {
                raw: raw.clone(),
                bindings,
                negate,
                paint,
            },
        });
    }

    fn node(&mut self, n: &Node, s: &Node, root: bool) {
        match (n, s) {
            (Node::Element { .. }, Node::Element { .. }) => self.element(n, s, root, None),
            (Node::Text(t), _) => self.out.push_str(&text(t)),
            (Node::Outlet, Node::Outlet) => self.out.push_str("{{ __outlet | safe }}"),
            (Node::Slot(e), Node::Slot(_)) => {
                self.slot(e, Some(s), false);
            }
            (Node::If { .. }, Node::If { .. }) => self.if_node(n, s),
            (Node::For { .. }, Node::For { .. }) => self.for_node(n, s),
            (Node::Component { .. }, Node::Component { .. }) => self.component(n, s, None),
            (Node::Fragment(cs), Node::Fragment(ss)) => self.nodes(cs, ss),
            _ => self.diagnostics.push(Diagnostic::error(
                "lower-shape",
                "the placed template does not match its structural snapshot",
                0,
                "report this compiler bug",
            )),
        }
    }

    fn nodes(&mut self, cs: &[Node], ss: &[Node]) {
        for (c, s) in cs.iter().zip(ss) {
            self.node(c, s, false);
        }
    }

    /// `{{ … | e }}`, with `<span x-text>` when reactive and `wrap`.
    fn slot(&mut self, e: &Expr, se: Option<&Node>, lone: bool) -> Option<String> {
        let raw = match se {
            Some(Node::Slot(s)) => raw_of(e, Some(s)),
            _ => None,
        };
        // An inlined child's `{children}`: the parent's markup.
        if let (
            Some(i),
            Some(RawExpr {
                kind:
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    },
                ..
            }),
        ) = (&self.inline, raw)
            && let Some(PropBinding::Markup(m)) = i.props.get(name)
        {
            self.out.push_str(m);
            return None;
        }
        let paint = format!("{{{{ {} | e }}}}", self.value(e));
        match self.reactive(raw, e) {
            Some(b) => {
                let d = self.value_member(raw.unwrap(), b, Paint::Text);
                if lone {
                    self.out.push_str(&paint);
                    Some(d)
                } else {
                    self.out
                        .push_str(&format!("<span x-text=\"{d}\">{paint}</span>"));
                    None
                }
            }
            None => {
                self.out.push_str(&paint);
                None
            }
        }
    }

    /// Prints an element; `extra` are host attributes for an inlined child.
    fn element(&mut self, n: &Node, s: &Node, root: bool, extra: Option<&str>) {
        let (
            Node::Element {
                tag,
                attrs,
                children,
                host,
                ..
            },
            Node::Element {
                attrs: sattrs,
                children: schildren,
                ..
            },
        ) = (n, s)
        else {
            return;
        };
        let mut open = format!("<{tag}");
        if let Some(x) = extra {
            open.push_str(x);
        }
        let model = model_pair(attrs, &self.f);
        for (a, sa) in attrs.iter().zip(sattrs) {
            self.attr(a, sa, tag, attrs, model.as_deref(), &mut open);
        }
        if let Some(m) = &model {
            open.push_str(&format!(" x-model=\"{m}\""));
        }
        // A lone reactive slot child puts x-text on this element (Review Focus 1).
        let lone = matches!(children.as_slice(), [Node::Slot(_)]);
        let mut body = String::new();
        std::mem::swap(&mut body, &mut self.out);
        let mut text_directive = None;
        if lone {
            if let (Node::Slot(e), Some(se)) = (&children[0], schildren.first()) {
                text_directive = self.slot(e, Some(se), true);
            }
        } else {
            self.nodes(children, schildren);
        }
        std::mem::swap(&mut body, &mut self.out);
        if let Some(d) = text_directive {
            open.push_str(&format!(" x-text=\"{d}\""));
        }
        if *host && root {
            // After the body: x-props seeds the props the members read.
            let host_attrs = self.host_attrs();
            open.insert_str(tag.len() + 1, &host_attrs);
        }
        self.out.push_str(&open);
        self.out.push('>');
        if VOID.contains(&tag.as_str()) {
            return;
        }
        self.out.push_str(&body);
        self.out.push_str(&format!("</{tag}>"));
    }

    fn host_attrs(&mut self) -> String {
        let ir = self.f.ir;
        if !self.native {
            return String::new();
        }
        // Roots the chunk reads as a whole (client_props), plus the exact
        // paths painted values read.
        let mut seed: BTreeSet<String> = ir.client_props.iter().cloned().collect();
        seed.extend(self.prop_seen.borrow().iter().cloned());
        let seed = brust_minimal(seed);
        self.prop_reads = seed.clone();
        let value_of = |p: &String| -> String {
            match &self.inline {
                None if p == "*" => "_props".into(),
                None => p.clone(),
                Some(i) => match i.props.get(p) {
                    Some(PropBinding::Expr(e)) => e.clone(),
                    _ => "none".into(),
                },
            }
        };
        let (x_data, bind) = match &self.inline_host {
            Some((d, b)) => (d.clone(), b.clone()),
            None => (ir.id.clone(), None),
        };
        let mut s = format!(" x-data=\"{x_data}\"");
        // A whole-props read seeds every prop.
        let dict: Vec<String> = if seed.contains("*") {
            vec![]
        } else {
            seed_tree(&seed)
                .into_iter()
                .map(|(root, node)| {
                    let base = value_of(&root);
                    format!("{}: {}", jinja_string(&root), node.jinja(&base))
                })
                .collect()
        };
        // The client reads its `useId` values from props (`_id{k}`).
        let ids: Vec<String> = (0..ir.id_bindings.len())
            .map(|k| format!("\"_id{k}\": {}", self.id_ref(k)))
            .collect();
        if seed.contains("*") && !ids.is_empty() {
            self.diagnostics.push(Diagnostic::error(
                "lower-shape",
                "a component that reads its whole props object cannot also seed useId values",
                0,
                "destructure the props",
            ));
        }
        let dict: Vec<String> = dict.into_iter().chain(ids).collect();
        if seed.contains("*") {
            let all = match &self.inline {
                None => "_props".to_string(),
                Some(i) => format!(
                    "{{{}}}",
                    i.props
                        .iter()
                        .filter_map(|(k, v)| match v {
                            PropBinding::Expr(e) => Some(format!("{}: {e}", jinja_string(k))),
                            PropBinding::Markup(_) => None,
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            };
            s.push_str(&format!(" x-props='{{{{ {all} | json_attr }}}}'"));
        } else if !dict.is_empty() {
            s.push_str(&format!(
                " x-props='{{{{ {{{}}} | json_attr }}}}'",
                dict.join(", ")
            ));
        }
        if let Some(b) = bind {
            s.push_str(&format!(" x-props-bind=\"{b}\""));
        }
        s
    }

    #[allow(clippy::too_many_arguments)]
    fn attr(
        &mut self,
        a: &Attr,
        sa: &Attr,
        tag: &str,
        all: &[Attr],
        model: Option<&str>,
        open: &mut String,
    ) {
        match a {
            Attr::Static { name, value } => {
                let html = attr_name(name);
                if is_refused_attr(&html) || (is_url_attr(&html) && !safe_url(value)) {
                    self.refuse(&html, tag);
                    return;
                }
                if value.is_empty() && is_boolean_attr(&html) {
                    open.push_str(&format!(" {html}"));
                } else {
                    open.push_str(&format!(" {html}=\"{}\"", text(value)));
                }
            }
            Attr::Dynamic { name, value } => {
                let html = attr_name(name);
                if is_refused_attr(&html) {
                    self.refuse(&html, tag);
                    return;
                }
                let raw = match sa {
                    Attr::Dynamic { value: sv, .. } => raw_of(value, Some(sv)),
                    _ => None,
                };
                let v = self.value(value);
                let style_obj = match raw {
                    Some(RawExpr {
                        kind: RawKind::Object(props),
                        ..
                    }) if html == "style" && matches!(value, Expr::Server(_)) => Some(props),
                    _ => None,
                };
                if let Some(props) = style_obj {
                    let dict: Vec<String> = props
                        .iter()
                        .map(|(k, pv)| format!("{}: {}", jinja_string(k), self.jinja(pv)))
                        .collect();
                    open.push_str(&format!(
                        " style=\"{{{{ {{{}}} | style_css | e }}}}\"",
                        dict.join(", ")
                    ));
                } else if html == "style" {
                    // A style object held in a variable or prop: the same CSS
                    // rule; an undefined/null style omits the attribute (F36).
                    open.push_str(&format!(
                        "{{% if ({v}) | present %}} style=\"{{{{ ({v}) | style_css | e }}}}\"{{% endif %}}"
                    ));
                } else if is_boolean_attr(&html) {
                    open.push_str(&format!("{{% if ({v}) | truthy %}} {html}{{% endif %}}"));
                } else if is_url_attr(&html) {
                    // Server side of the runtime's URL rule: an unsafe scheme
                    // is not rendered (XSS through a `javascript:` prop).
                    open.push_str(&format!(
                        "{{% if ({v} | present) and ({v} | url_ok) %}} {html}=\"{{{{ {v} | attr_str | e }}}}\"{{% endif %}}"
                    ));
                } else {
                    open.push_str(&format!(
                        "{{% if {v} | present %}} {html}=\"{{{{ {v} | attr_str | e }}}}\"{{% endif %}}"
                    ));
                }
                if model.is_some() && (html == "value" || html == "checked") {
                    return;
                }
                if let Some(b) = self.reactive(raw, value) {
                    let paint = if html == "style" {
                        Paint::Style
                    } else if is_boolean_attr(&html) {
                        Paint::Raw
                    } else {
                        Paint::Attr
                    };
                    let d = self.value_member(raw.unwrap(), b, paint);
                    open.push_str(&format!(" x-bind-{html}=\"{d}\""));
                }
            }
            Attr::Event { event, handler } => {
                if model.is_some() && event == "change" {
                    return;
                }
                if !self.native {
                    return;
                }
                let ev = dom_event(event, tag, all);
                let bindings = self
                    .f
                    .ir
                    .handlers
                    .iter()
                    .find(|h| &h.name == handler)
                    .map(|h| h.item_scoped.clone())
                    .unwrap_or_default();
                open.push_str(&format!(" x-on-{ev}=\"{}\"", directive(handler, &bindings)));
            }
            Attr::Ref { name } => {
                if self.native {
                    open.push_str(&format!(" x-ref=\"{name}\""));
                }
            }
            Attr::Spread(_) => {}
        }
    }

    fn refuse(&mut self, html: &str, tag: &str) {
        self.diagnostics.push(Diagnostic::warning(
            "unsafe-attr",
            format!("`{html}` on <{tag}> is not rendered (inline handlers, srcdoc and unsafe URLs are refused)"),
            0,
            "use an event prop (onClick) and http(s)/relative URLs",
        ));
    }

    fn if_node(&mut self, n: &Node, s: &Node) {
        let (
            Node::If { cond, then, else_ },
            Node::If {
                cond: sc,
                then: st,
                else_: se,
            },
        ) = (n, s)
        else {
            return;
        };
        let raw = match sc {
            Expr::Raw(r) => Some(r),
            _ => None,
        };
        let c = self.value(cond);
        match self.reactive(raw, cond) {
            None => {
                self.out.push_str(&format!("{{% if ({c}) | truthy %}}"));
                self.nodes(then, st);
                if !else_.is_empty() {
                    self.out.push_str("{% else %}");
                    self.nodes(else_, se);
                }
                self.out.push_str("{% endif %}");
            }
            Some(b) => {
                let yes = self.next("_c");
                self.push_member(&yes, raw.unwrap(), b.clone(), false, Paint::Raw);
                let no = format!("{yes}_not");
                if !else_.is_empty() {
                    self.push_member(&no, raw.unwrap(), b.clone(), true, Paint::Raw);
                }
                let yes_d = directive(&yes, &b);
                let no_d = directive(&no, &b);
                let (then_on, then_off) =
                    self.twice(|p, hidden| p.branch(then, st, &yes_d, hidden));
                let (else_on, else_off) = if else_.is_empty() {
                    (String::new(), String::new())
                } else {
                    self.twice(|p, hidden| p.branch(else_, se, &no_d, hidden))
                };
                self.out.push_str(&format!(
                    "{{% if ({c}) | truthy %}}{then_on}{else_off}{{% else %}}{then_off}{else_on}{{% endif %}}"
                ));
            }
        }
    }

    /// Prints the visible copy, then the hidden copy of the same nodes with the
    /// same member numbers (the hidden copy defines no new members).
    fn twice(&mut self, mut f: impl FnMut(&mut Self, bool) -> String) -> (String, String) {
        let before = (
            self.counts.clone(),
            self.ssr.clone(),
            self.instances.clone(),
        );
        let visible = f(self, false);
        let after = (
            self.counts.clone(),
            self.ssr.clone(),
            self.instances.clone(),
            self.members.len(),
        );
        (self.counts, self.ssr, self.instances) = before;
        let hidden = f(self, true);
        self.members.truncate(after.3);
        (self.counts, self.ssr, self.instances) = (after.0, after.1, after.2);
        (visible, hidden)
    }

    /// One `x-if` branch: its single element carries the directive (a
    /// `<brust-if>` wrapper otherwise — Review Focus 2); `hidden` renders the
    /// template the runtime clones when the server-side value was false.
    fn branch(&mut self, ns: &[Node], ss: &[Node], d: &str, hidden: bool) -> String {
        let mut saved = String::new();
        std::mem::swap(&mut saved, &mut self.out);
        let attr = format!(" x-if=\"{d}\"{}", if hidden { " hidden" } else { "" });
        match (ns, ss) {
            ([n @ Node::Element { .. }], [s]) => self.element(n, s, false, Some(&attr)),
            _ => {
                self.out
                    .push_str(&format!("<brust-if style=\"display:contents\"{attr}>"));
                self.nodes(ns, ss);
                self.out.push_str("</brust-if>");
            }
        }
        std::mem::swap(&mut saved, &mut self.out);
        if hidden {
            format!("<!--x-if-->{saved}")
        } else {
            saved
        }
    }

    fn for_node(&mut self, n: &Node, s: &Node) {
        let (
            Node::For {
                source,
                item,
                index,
                body,
                ..
            },
            Node::For {
                source: ss,
                key: sk,
                body: sb,
                ..
            },
        ) = (n, s)
        else {
            return;
        };
        let src_raw = match ss {
            Expr::Raw(r) => Some(r.clone()),
            _ => None,
        };
        let src = self.value(source);
        let directive_row = self.native
            && (src_raw
                .as_ref()
                .is_some_and(|r| !self.f.deps(r, &self.scope()).state.is_empty())
                || body.iter().any(|b| needs_directives(b, &self.f)));
        let var = {
            let v = self.loop_var.get() + 1;
            self.loop_var.set(v);
            format!("_i{v}")
        };
        let mut x_for = String::new();
        if directive_row && let (Some(sr), Expr::Raw(kr)) = (&src_raw, sk) {
            let l = self.next("_l");
            let k = self.next("_k");
            // An inner list reading an outer row's binding is a function of it.
            let deps = self.f.deps(sr, &self.scope());
            let outer: Vec<String> = self
                .scope()
                .into_iter()
                .filter(|b| deps.loop_bindings.contains(b))
                .collect();
            self.members.push(Member {
                name: l.clone(),
                def: MemberDef::List {
                    raw: sr.clone(),
                    bindings: outer.clone(),
                },
            });
            let l = directive(&l, &outer);
            // The runtime calls the key function with the item only: a key that
            // reads the index or an outer row falls back to the item's identity.
            let mut kscope = self.scope();
            kscope.push(item.clone());
            kscope.extend(index.iter().cloned());
            let kdeps = self.f.deps(kr, &kscope);
            let key_raw = if kdeps.loop_bindings.iter().any(|b| b != item) {
                self.diagnostics.push(Diagnostic::warning(
                    "key-not-item",
                    format!(
                        "the key of the list over `{item}` reads more than the item; rows are keyed by item identity on the client"
                    ),
                    kr.loc,
                    "key rows by a field of the item (key={item.id})",
                ));
                RawExpr {
                    loc: kr.loc,
                    kind: RawKind::Ident {
                        name: item.clone(),
                        kind: IdentKind::LoopBinding,
                    },
                }
            } else {
                kr.clone()
            };
            self.members.push(Member {
                name: k.clone(),
                def: MemberDef::Key {
                    raw: key_raw,
                    item: item.clone(),
                },
            });
            let binds = match index {
                Some(i) => format!("{item}, {i}"),
                None => item.clone(),
            };
            x_for = format!(" x-for=\"{binds} in {l} by {k}\"");
        }
        self.frames.push(Frame {
            item: item.clone(),
            index: index.clone(),
            var: var.clone(),
            directive: !x_for.is_empty(),
        });
        let mut sets = format!("{{% set {var} = loop.index0 %}}");
        if let Some(i) = index {
            sets.push_str(&format!("{{% set {i}{} = loop.index0 %}}", self.suffix()));
        }
        let (row, empty) = if x_for.is_empty() {
            (self.row(body, sb, &x_for, false), String::new())
        } else {
            let (row, hidden) = self.twice(|p, hidden| {
                let blank = p.blank;
                p.blank |= hidden;
                let r = p.row(body, sb, &x_for, hidden);
                p.blank = blank;
                r
            });
            (row, format!("{{% else %}}<!--x-for-->{hidden}"))
        };
        self.frames.pop();
        self.out.push_str(&format!(
            "{{% for {item}{} in {src} %}}{sets}{row}{empty}{{% endfor %}}",
            self.suffix()
        ));
    }

    /// One list row; with `x-for`, the row is one element (`<brust-row>`
    /// wrapper otherwise) carrying the directive.
    fn row(&mut self, ns: &[Node], ss: &[Node], x_for: &str, hidden: bool) -> String {
        let mut saved = String::new();
        std::mem::swap(&mut saved, &mut self.out);
        let attr = format!("{x_for}{}", if hidden { " hidden" } else { "" });
        if x_for.is_empty() {
            self.nodes(ns, ss);
        } else {
            match (ns, ss) {
                ([n @ Node::Element { .. }], [s]) => self.element(n, s, false, Some(&attr)),
                // F32: a single inlined component whose template is one element carries `x-for`
                // itself (the runtime lets an `x-for` element also be a host, `directives/index.ts`).
                // `x-if` cannot: a host root with `x-if` is skipped by the parent's walk.
                ([n @ Node::Component { .. }], [s]) if self.inline_root_is_element(n) => {
                    self.component(n, s, Some(&attr))
                }
                _ => {
                    self.out
                        .push_str(&format!("<brust-row style=\"display:contents\"{attr}>"));
                    self.nodes(ns, ss);
                    self.out.push_str("</brust-row>");
                }
            }
        }
        std::mem::swap(&mut saved, &mut self.out);
        saved
    }

    /// An inlined (native/static) component whose compiled template is a single element:
    /// that element can carry a row directive itself, so no wrapper is needed.
    fn inline_root_is_element(&self, n: &Node) -> bool {
        let Node::Component { name, tier, .. } = n else {
            return false;
        };
        if matches!(tier, Tier::React { .. }) {
            return false;
        }
        let Some(child) = self.f.ir.children.iter().find(|c| &c.name == name) else {
            return false;
        };
        let id = child.id.clone().unwrap_or_else(|| name.clone());
        (self.ctx.resolve)(&id).is_some_and(|c| matches!(c.template, Node::Element { .. }))
    }

    /// `extra`: attributes for the child's root element (a list-row directive).
    fn component(&mut self, n: &Node, s: &Node, extra: Option<&str>) {
        let (
            Node::Component {
                name,
                props,
                children,
                link,
                tier,
                ..
            },
            Node::Component {
                props: sprops,
                children: schildren,
                ..
            },
        ) = (n, s)
        else {
            return;
        };
        let ir = self.f.ir;
        let Some(child) = ir.children.iter().find(|c| &c.name == name) else {
            return;
        };
        let id = child.id.clone().unwrap_or_else(|| name.clone());
        let loops: String = self.frames.iter().map(|f| format!("[{}]", f.var)).collect();
        if let Tier::React { client_only, .. } = tier {
            if *client_only {
                let dict = self.props_dict(props, sprops);
                self.out
                    .push_str(&crate::lower::island_host(&id, &dict, ""));
                return;
            }
            let k = self.ssr.entry(id.clone()).or_insert(0);
            *k += 1;
            let out = if *k == 1 {
                format!("_ssr_{id}")
            } else {
                format!("_ssr_{id}_{k}")
            };
            let per_item = ir.jobs.iter().any(|j| {
                matches!(j.kind, JobKind::Ssr { .. })
                    && j.outputs.contains(&out)
                    && j.per_item.is_some()
            });
            let idx = if per_item { loops.as_str() } else { "" };
            let dict = self.props_dict(props, sprops);
            self.out.push_str(&crate::lower::island_host(
                &id,
                &dict,
                &format!("{{{{ {out}{idx} | safe }}}}"),
            ));
            return;
        }
        // Native / static child: inline its template.
        let Some(child_ir) = (self.ctx.resolve)(&id) else {
            self.diagnostics.push(Diagnostic::error(
                "lower-child",
                format!("child <{name}> ({id}) was not compiled"),
                0,
                "report this compiler bug",
            ));
            return;
        };
        if self.inline.is_some()
            && (child_ir.use_id_slots > 0
                || child_ir
                    .jobs
                    .iter()
                    .any(|j| matches!(j.kind, JobKind::Precompute)))
        {
            // The slot key is built from this printer's own counters and frames, which restart
            // inside an inlined child: instances of such a grandchild would collide.
            self.diagnostics.push(Diagnostic::error(
                "nested-instance",
                format!("<{name}> has a job or useId and is used inside another inlined component"),
                0,
                "use it directly in the route component (ledger F53)",
            ));
            return;
        }
        let k = {
            let k = self.instances.entry(id.clone()).or_insert(0);
            *k += 1;
            *k
        };
        let mut bindings = HashMap::new();
        for ((pname, v), (_, sv)) in props.iter().zip(sprops) {
            if matches!(v, Expr::ClientOnly { .. }) {
                continue;
            }
            let _ = sv;
            bindings.insert(pname.clone(), PropBinding::Expr(self.value(v)));
        }
        if !children.is_empty() {
            let mut saved = String::new();
            std::mem::swap(&mut saved, &mut self.out);
            self.nodes(children, schildren);
            std::mem::swap(&mut saved, &mut self.out);
            bindings.insert("children".into(), PropBinding::Markup(saved));
        }
        let bind = link
            .and_then(|l| ir.child_links.iter().find(|c| c.id == l))
            .map(|l| {
                let name = l.props_member.clone();
                let d = directive(&name, &l.item_scoped);
                let raws: Vec<(String, RawExpr)> = props
                    .iter()
                    .zip(sprops)
                    .filter_map(|((k, v), (_, sv))| {
                        raw_of(v, Some(sv)).map(|r| (k.clone(), r.clone()))
                    })
                    .collect();
                self.members.push(Member {
                    name,
                    def: MemberDef::Link {
                        props: raws,
                        bindings: l.item_scoped.clone(),
                    },
                });
                d
            });
        let inline = Inline {
            props: bindings,
            bind: bind.clone(),
            slots: format!("__{id}_{k}{loops}"),
            suffix: format!("_{}{k}", short(&id)),
        };
        let Some(mut p) = Printer::new(child_ir, self.ctx, Some(inline), self.loop_var) else {
            return;
        };
        p.blank = self.blank;
        p.native = !matches!(child_ir.tier, Tier::Static) || bind.is_some();
        p.inline_host = Some((child_ir.id.clone(), bind));
        p.preamble();
        let (ct, cs) = (&child_ir.template, &p.f.structural.template);
        match extra {
            Some(x) => p.element(ct, cs, true, Some(x)),
            None => p.node(ct, cs, true),
        }
        self.out.push_str(&p.out);
        self.diagnostics.append(&mut p.diagnostics);
    }

    fn props_dict(&self, props: &[(String, Expr)], _s: &[(String, Expr)]) -> String {
        let items: Vec<String> = props
            .iter()
            .filter(|(_, v)| !matches!(v, Expr::ClientOnly { .. }))
            .map(|(k, v)| format!("{}: {}", jinja_string(k), self.value(v)))
            .collect();
        format!("{{{}}}", items.join(", "))
    }
}

/// Sorted paths with any path covered by a shorter one removed.
fn brust_minimal(paths: BTreeSet<String>) -> BTreeSet<String> {
    crate::analyze::passes::deps::minimal_paths(paths)
        .into_iter()
        .collect()
}

/// Prop paths as a tree: a root read whole, or the members read below it.
enum SeedNode {
    Whole,
    Fields(std::collections::BTreeMap<String, SeedNode>),
}

impl SeedNode {
    fn jinja(&self, base: &str) -> String {
        match self {
            SeedNode::Whole => base.to_string(),
            SeedNode::Fields(f) => format!(
                "{{{}}}",
                f.iter()
                    .map(|(k, n)| {
                        // `list.length` is not a key of the seeded JSON: seed the count only,
                        // never the list (its items may be data the page does not show).
                        if k == "length" && matches!(n, SeedNode::Whole) {
                            return format!(
                                "{}: (({base} | length) if {base} is defined and {base} is not none else none)",
                                jinja_string(k)
                            );
                        }
                        let at = format!("({base})[{}]", jinja_string(k));
                        format!("{}: {}", jinja_string(k), n.jinja(&at))
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

fn seed_tree(paths: &BTreeSet<String>) -> std::collections::BTreeMap<String, SeedNode> {
    let mut roots = std::collections::BTreeMap::new();
    for p in paths {
        let mut parts = p.split('.');
        let Some(root) = parts.next() else { continue };
        let mut node = roots
            .entry(root.to_string())
            .or_insert_with(|| SeedNode::Fields(Default::default()));
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() {
            *node = SeedNode::Whole;
            continue;
        }
        for (i, part) in rest.iter().enumerate() {
            let SeedNode::Fields(f) = node else { break };
            let last = i + 1 == rest.len();
            node = f.entry(part.to_string()).or_insert_with(|| {
                if last {
                    SeedNode::Whole
                } else {
                    SeedNode::Fields(Default::default())
                }
            });
        }
    }
    roots
}

/// `x-*` value: `member` or `member:b1,b2`.
fn directive(member: &str, bindings: &[String]) -> String {
    if bindings.is_empty() {
        member.to_string()
    } else {
        format!("{member}:{}", bindings.join(","))
    }
}

/// Static text: escaped, and `{` as an entity so jinja never sees a tag.
fn text(s: &str) -> String {
    escape_attr(s).replace('{', "&#123;")
}

/// The first 8 characters of an id's hash part, for instance suffixes.
fn short(id: &str) -> String {
    id.rsplit('_')
        .next()
        .unwrap_or(id)
        .chars()
        .take(4)
        .collect()
}

/// React's `onChange` on a text-like field is the DOM `input` event (F16).
fn dom_event(event: &str, tag: &str, attrs: &[Attr]) -> String {
    if event != "change" {
        return event.to_string();
    }
    let ty = attrs.iter().find_map(|a| match a {
        Attr::Static { name, value } if name == "type" => Some(value.as_str()),
        _ => None,
    });
    let text_like = match tag {
        "textarea" => true,
        // React's onChange is the input event everywhere but on these.
        "input" => !matches!(ty, Some("checkbox" | "radio" | "file")),
        _ => false,
    };
    if text_like { "input" } else { "change" }.to_string()
}

/// The controlled-input pair (spec §7.1): `value={q}` (or `checked={q}`) with
/// `onChange={e => setQ(e.target.value)}` → the state name for `x-model`.
fn model_pair(attrs: &[Attr], f: &Facts<'_>) -> Option<String> {
    let state = attrs.iter().find_map(|a| match a {
        Attr::Dynamic {
            name,
            value:
                Expr::Server(ServerExpr(RawExpr {
                    kind:
                        RawKind::Ident {
                            name: s,
                            kind: IdentKind::State,
                        },
                    ..
                })),
        } if name == "value" || name == "checked" => Some((name.as_str(), s.clone())),
        _ => None,
    })?;
    let handler = attrs.iter().find_map(|a| match a {
        Attr::Event { event, handler } if event == "change" => Some(handler),
        _ => None,
    })?;
    let h = f.ir.handlers.iter().find(|h| &h.name == handler)?;
    let RawKind::Arrow {
        params,
        body: crate::ir::ArrowBody::Expr(body),
        ..
    } = &h.body.kind
    else {
        return None;
    };
    let [e] = params.as_slice() else { return None };
    let RawKind::Call { callee, args } = &body.kind else {
        return None;
    };
    let RawKind::Ident {
        name: setter,
        kind: IdentKind::Setter,
    } = &callee.kind
    else {
        return None;
    };
    if f.setters.get(setter) != Some(&state.1) {
        return None;
    }
    let field = if state.0 == "checked" {
        "checked"
    } else {
        "value"
    };
    match args.as_slice() {
        [
            RawExpr {
                kind: RawKind::Member { target, name, .. },
                ..
            },
        ] if name == field => match &target.kind {
            RawKind::Member {
                target: t, name: n, ..
            } if n == "target" => match &t.kind {
                RawKind::Ident { name: en, .. } if en == e => Some(state.1),
                _ => None,
            },
            _ => None,
        },
        _ => None,
    }
}

/// Whether a list body needs `x-for` (it carries directives).
fn needs_directives(n: &Node, f: &Facts<'_>) -> bool {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            attrs.iter().any(|a| match a {
                Attr::Event { .. } | Attr::Ref { .. } => true,
                Attr::Dynamic { value, .. } => expr_reactive(value, f),
                _ => false,
            }) || children.iter().any(|c| needs_directives(c, f))
        }
        Node::Slot(e) => expr_reactive(e, f),
        Node::If {
            cond, then, else_, ..
        } => expr_reactive(cond, f) || then.iter().chain(else_).any(|c| needs_directives(c, f)),
        Node::For { body, source, .. } => {
            expr_reactive(source, f) || body.iter().any(|c| needs_directives(c, f))
        }
        Node::Component { link, children, .. } => {
            link.is_some() || children.iter().any(|c| needs_directives(c, f))
        }
        Node::Fragment(cs) => cs.iter().any(|c| needs_directives(c, f)),
        Node::Text(_) | Node::Outlet => false,
    }
}

fn expr_reactive(e: &Expr, f: &Facts<'_>) -> bool {
    match e {
        Expr::Precomputed {
            state_dependent, ..
        } => *state_dependent,
        Expr::Server(ServerExpr(r)) => !f.deps(r, &[]).state.is_empty(),
        _ => false,
    }
}

impl Expr {
    /// Location of the expression when it still carries one.
    pub fn raw_loc(&self) -> Option<u32> {
        match self {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => Some(r.loc),
            _ => None,
        }
    }
}
