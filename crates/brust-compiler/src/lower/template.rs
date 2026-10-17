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
use super::common::{Facts, raw_of, store_jinja};
use super::names::Seeds;
use super::server_expr::{JinjaCtx, UNDEFINED, jinja_string, to_jinja};
use super::{LowerCtx, Member, MemberDef, Paint};
use crate::analyze::passes::children::REST_INPUT;
use crate::ir::{
    Attr, ComponentIR, Diagnostic, Expr, IdentKind, JobKind, Node, RawExpr, RawKind, ServerExpr,
    Tier, VOID,
};
use brust_jinja::{
    AttrKind, attr_kind, attr_name, escape_attr, is_boolean_attr, is_refused_attr, is_url_attr,
    safe_url,
};
use std::cell::Cell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

/// What a prop of an inlined child reads in the parent's template.
#[derive(Clone, Debug)]
pub enum PropBinding {
    /// A jinja expression in the parent's scope.
    Expr(String),
    /// JSX children: markup printed in the parent's scope.
    Markup(String),
    /// An event handler the parent hoisted (shadcn S1.3): the `x-on-*` directive value naming the
    /// parent's member. Bound where a spread lands it on an element; never a value.
    Handler(String),
    /// A live value the parent bound itself (2b-handlers): the finished attribute text (server print and
    /// `x-bind-*` member) in the parent's scope, bound where a spread lands it on an element.
    Live(String),
    /// A ref the parent bound itself on an inlined `forwardRef` child (F267): the name of the parent's ref cell, bound
    /// as `x-ref` where the child's own `ref={forwardedRef}` is.
    Ref(String),
}

/// One piece of a call site's props, in source order (shadcn S1.2): a named prop, or a spread
/// object whose keys are known only at render (a jinja expression of a map).
#[derive(Clone, Debug)]
pub enum Seg {
    Named(String, PropBinding),
    Spread(String),
}

/// How an instance is embedded: `None` for the component itself.
pub struct Inline {
    /// The call site's props in source order; JSX children last (React sets them after every
    /// attribute, so they win over a `children` in a spread). A later segment wins.
    pub segs: Vec<Seg>,
    /// `x-props-bind` value when the parent links this instance.
    pub bind: Option<String>,
    /// Template variable of this instance's job output (`__<id>_<k>[…]`).
    pub slots: String,
    /// The parent's open loops whose `_iN` the `slots` text names: printing a slot read marks them.
    pub slot_loops: Vec<Rc<Cell<bool>>>,
    /// Suffix for this instance's seed and derived variables.
    pub suffix: String,
    /// The call site has a literal `asChild` (R34.29 b): its single child element is what this
    /// component's polymorphic element prints as.
    pub as_child: Option<AsChild>,
    /// The build ran this instance's job (F149, R34.90): slot -> value, printed as literals.
    pub folded: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    /// A child fused into its parent's job (R34.96): its slot -> the parent job's output that holds it.
    /// Its slots are read from the parent's slot dict (`slots`, empty when the parent is the route
    /// component and its slots are top-level variables) and the parent's `folded` values.
    pub rename: std::collections::BTreeMap<String, String>,
    /// Props the call site writes with a value only the client has (a function): given, so not absent (F234).
    pub client_only: Vec<String>,
}

/// The child element of a Radix-`Slot`-style call (`<Button asChild><a href="/x">Go</a></Button>`),
/// printed in the call site's scope: the component's polymorphic element becomes this element,
/// the component's attributes merged under its own (R34.30).
#[derive(Clone, Debug)]
pub struct AsChild {
    pub tag: String,
    /// The child's attributes: React name and a jinja expression of the call site.
    pub attrs: Vec<(String, String)>,
    /// The child's children, printed in the call site's scope.
    pub body: String,
    /// F363a: the child is a static component, not an element: the polymorphic element's attributes become its props.
    pub component: Option<ChildCall>,
}

/// A static component given as the child of an `asChild` call (F363a): its props as the call site binds them.
#[derive(Clone, Debug)]
pub struct ChildCall {
    pub id: String,
    pub k: u32,
    pub segs: Vec<Seg>,
    pub client_only: Vec<String>,
}

impl Inline {
    /// What prop `name` reads: the last named binding, or a spread after it that may carry the
    /// key (`spread_get(d, "name", earlier)`).
    pub fn get(&self, name: &str) -> Option<PropBinding> {
        let mut cur: Option<PropBinding> = None;
        for s in &self.segs {
            match s {
                Seg::Named(k, b) if k == name => cur = Some(b.clone()),
                Seg::Named(..) => {}
                Seg::Spread(d) => {
                    let earlier = match &cur {
                        Some(PropBinding::Expr(e)) => e.clone(),
                        _ => UNDEFINED.into(),
                    };
                    cur = Some(PropBinding::Expr(format!(
                        "spread_get({d}, {}, {earlier})",
                        jinja_string(name)
                    )));
                }
            }
        }
        cur
    }

    /// The call site WRITES prop `name` (a named attribute, never one a spread may carry): what a compiler-reserved prop
    /// needs, since `get` answers `spread_get(…)` for any name once a spread is among the segments.
    pub fn writes(&self, name: &str) -> bool {
        self.segs
            .iter()
            .any(|s| matches!(s, Seg::Named(k, _) if k == name))
    }

    /// The parent's ref cell bound on this instance (F267).
    pub fn ref_binding(&self) -> Option<&str> {
        self.segs.iter().rev().find_map(|s| match s {
            Seg::Named(_, PropBinding::Ref(n)) => Some(n.as_str()),
            _ => None,
        })
    }

    /// No spread of unknown keys: every key the call site passes is listed.
    pub fn known(&self) -> bool {
        self.segs.iter().all(|s| matches!(s, Seg::Named(..)))
    }

    /// The listed props minus `omit`, merged as a JS object (a later key keeps the first key's
    /// position). Only meaningful when [`Self::known`].
    pub fn entries(&self, omit: &[String]) -> Vec<(String, PropBinding)> {
        let mut out: Vec<(String, PropBinding)> = Vec::new();
        for s in &self.segs {
            if let Seg::Named(k, b) = s
                && !omit.contains(k)
            {
                match out.iter_mut().find(|(n, _)| n == k) {
                    Some(slot) => slot.1 = b.clone(),
                    None => out.push((k.clone(), b.clone())),
                }
            }
        }
        out
    }

    /// The whole props object minus `omit` as one jinja map (markup children are not data).
    pub fn object(&self, omit: &[String]) -> String {
        let segs: Vec<String> = self
            .segs
            .iter()
            .filter_map(|s| match s {
                Seg::Named(k, PropBinding::Expr(e)) if !omit.contains(k) => {
                    Some(format!("[{}, {e}]", jinja_string(k)))
                }
                Seg::Named(..) => None,
                Seg::Spread(d) => Some(omit_jinja(d, omit)),
            })
            .collect();
        format!("spread_merge({})", segs.join(", "))
    }
}

/// `d` without the keys in `omit` (a rest object), as jinja.
fn omit_jinja(d: &str, omit: &[String]) -> String {
    if omit.is_empty() {
        return d.to_string();
    }
    let keys: Vec<String> = omit.iter().map(|k| jinja_string(k)).collect();
    format!("(({d}) | omit([{}]))", keys.join(", "))
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
    /// Recorded by the printer: `var` was printed (a per-item slot name).
    var_used: Rc<Cell<bool>>,
    /// Recorded by the printer: the user-declared index was resolved or bound.
    index_used: Cell<bool>,
    /// The row carries `x-for`: loop reads inside it get directives.
    directive: bool,
    /// F325: the list's source reads module-level data (`module_source`): props do not make its rows reactive.
    module: bool,
}

pub struct Printer<'a, 'c> {
    ctx: &'c LowerCtx<'a>,
    f: Facts<'c>,
    inline: Option<Inline>,
    loop_var: &'c Cell<u32>,
    out: String,
    members: Vec<Member>,
    counts: HashMap<&'static str, u32>,
    /// F233: the names the component spells; a member never takes one (shared by the printers of one lowering, by id).
    seeds: Seeds,
    frames: Vec<Frame>,
    diagnostics: Vec<Diagnostic>,
    /// Prop roots the members read: they are seeded through `x-props`.
    prop_reads: BTreeSet<String>,
    prop_seen: std::cell::RefCell<BTreeSet<String>>,
    /// Host attributes of an inlined instance (`x-data`, `x-props-bind`).
    inline_host: Option<(String, Option<String>)>,
    /// The component whose `instances` records feed the slots this printer reads: the route-level component, also
    /// for the printers of the components inlined into it (F164, R34.96 re-base).
    inst_ir: &'c ComponentIR,
    /// Instances inlined so far, by child id.
    instances: HashMap<String, u32>,
    /// SSR outputs used so far, by child id.
    ssr: HashMap<String, u32>,
    native: bool,
    /// Printing the zero-row `x-for` template: it is cloned and re-bound by
    /// the runtime, so no value is evaluated (there is no item).
    blank: bool,
    /// Printing the children of `<script>` / `<style>`: static text goes out verbatim.
    raw_text: bool,
    /// The body of the element being opened, when it carries `dangerouslySetInnerHTML`.
    inner_html: Option<String>,
}

impl<'a, 'c> Printer<'a, 'c> {
    pub fn new(
        ir: &'c ComponentIR,
        ctx: &'c LowerCtx<'a>,
        inline: Option<Inline>,
        loop_var: &'c Cell<u32>,
        seeds: Seeds,
    ) -> Option<Self> {
        let structural = ir.structural.as_deref()?;
        Some(Printer {
            seeds,
            ctx,
            f: Facts::new(ir, structural),
            inst_ir: ir,
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
            raw_text: false,
            inner_html: None,
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

    /// The next member name `{prefix}{n}` that the component does not spell (nor its `_not` twin).
    fn next(&mut self, prefix: &'static str) -> String {
        let taken = self.seeds.of(self.f.ir);
        let n = self.counts.entry(prefix).or_insert(0);
        loop {
            *n += 1;
            let name = format!("{prefix}{n}");
            if !taken.contains(&name) && !taken.contains(&format!("{name}_not")) {
                return name;
            }
        }
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
        self.jinja_free(format!("_d{}{}", i + 1, self.suffix()))
    }

    /// F233: `base` as a template variable, or `base_1`, `base_2`, … when the component or the route component it is
    /// printed into spells it (a prop `_d1` is a template variable of that name too).
    fn jinja_free(&self, base: String) -> String {
        let own = self.seeds.of(self.f.ir);
        let root = self.seeds.of(self.inst_ir);
        let mut name = base.clone();
        let mut n = 0;
        while self.jinja_taken(&name, &own, &root) {
            n += 1;
            name = format!("{base}_{n}");
        }
        name
    }

    /// The seeds leave the prop keys out (no chunk binding is named by one), but a template reads each prop as the
    /// variable of its name.
    fn jinja_taken(
        &self,
        name: &str,
        own: &std::collections::HashSet<String>,
        root: &std::collections::HashSet<String>,
    ) -> bool {
        own.contains(name)
            || root.contains(name)
            || [self.f.ir, self.inst_ir]
                .iter()
                .any(|ir| ir.props.iter().any(|p| p.name == name))
    }

    fn names(&self) -> impl Fn(&str, &IdentKind) -> Option<String> + '_ {
        move |name: &str, kind: &IdentKind| match kind {
            IdentKind::Prop => {
                let base = match &self.inline {
                    None if name == "*" => "_props".into(),
                    // F278: the rest object as a VALUE (the hidden input of a clone), the props the pattern names left out
                    None if name == crate::ir::REST_PROPS => {
                        format!("({})", omit_jinja("_props", &self.rest_omits()))
                    }
                    // The template's own names (`loop`, `range`, ...) would be shadowed: read them off the props object.
                    None if crate::analyze::names::TEMPLATE_OWN.contains(&name) => {
                        format!("_props.{name}")
                    }
                    None => name.to_string(),
                    Some(i) if name == "*" => format!("({})", i.object(&[])),
                    Some(i) if name == crate::ir::REST_PROPS => {
                        format!("({})", i.object(&self.rest_omits()))
                    }
                    Some(i) => match i.get(name) {
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
            IdentKind::LoopBinding => {
                // Record a read of a loop index (the row needs its `set`).
                for f in &self.frames {
                    if f.index.as_deref() == Some(name) {
                        f.index_used.set(true);
                    }
                }
                self.inline
                    .is_some()
                    .then(|| format!("{name}{}", self.suffix()))
            }
            IdentKind::Local => Some(if self.f.derived.contains_key(name) {
                self.derived_var(name)
            } else if let Some(k) = self.f.ir.id_bindings.iter().position(|i| i == name) {
                // Read the server-seeded value directly: no template variable to shadow a prop.
                self.id_ref(k)
            } else {
                UNDEFINED.into()
            }),
            // Store paths are global: an inlined child prints the same text (no instance suffix).
            // An unresolved handle never lowers (tier React).
            IdentKind::Store { handle, key } => Some(match self.f.store_name(handle) {
                Some(n) => store_jinja(n, key.as_deref()),
                None => UNDEFINED.into(),
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
            // An inlined instance fed once (no row index, F142 R34.42) has the same job output in
            // every row, so the row template a client-rendered list clones carries it too.
            if let (
                Expr::Precomputed {
                    slot,
                    per_item: None,
                    state_dependent: false,
                    ..
                },
                Some(i),
            ) = (e, &self.inline)
                && i.slot_loops.is_empty()
            {
                return self.slot_ref(slot, false);
            }
            return UNDEFINED.into();
        }
        match e {
            Expr::Server(ServerExpr(r)) => self.jinja(r),
            Expr::Precomputed { slot, per_item, .. } => self.slot_ref(slot, per_item.is_some()),
            _ => UNDEFINED.into(),
        }
    }

    fn slot_ref(&self, slot: &str, per_item: bool) -> String {
        // R34.96: a fused child's slot is its parent's job output of another name.
        let slot = self
            .inline
            .as_ref()
            .and_then(|i| i.rename.get(slot))
            .map_or(slot, String::as_str);
        // F149 (R34.91): a slot the build computed prints as its value, through the same escaping.
        if let Some(v) = self
            .inline
            .as_ref()
            .and_then(|i| i.folded.as_ref())
            .and_then(|f| f.get(slot))
            && let Some(raw) = crate::analyze::const_fold::json_to_raw(v, 0)
        {
            return self.jinja(&raw);
        }
        let base = match &self.inline {
            None => slot.to_string(),
            Some(i) if i.slots.is_empty() => slot.to_string(),
            Some(i) => {
                for m in &i.slot_loops {
                    m.set(true);
                }
                format!("{}[{}]", i.slots, jinja_string(slot))
            }
        };
        if !per_item {
            return base;
        }
        format!("{base}{}", self.frame_vars())
    }

    /// `[_iN]…` for every open loop; records each variable as read.
    fn frame_vars(&self) -> String {
        self.frames
            .iter()
            .map(|f| {
                f.var_used.set(true);
                format!("[{}]", f.var)
            })
            .collect()
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
        self.reactive_as(raw, placed, false)
    }

    /// [`Self::reactive`]; `always`: the value is wanted as a client member even when nothing in it changes (a collection
    /// item's data is read by the runtime on demand, whatever it reads). Still `None` when the value is not computable
    /// in the chunk or the component is not native.
    fn reactive_as(
        &self,
        raw: Option<&RawExpr>,
        placed: &Expr,
        always: bool,
    ) -> Option<Vec<String>> {
        let raw = raw?;
        // `{children}` is markup the parent printed; it has no client value.
        if matches!(&raw.kind, RawKind::Ident { name, kind: IdentKind::Prop } if name == "children")
        {
            return None;
        }
        let deps = self.f.deps(raw, &self.scope());
        let in_row = self.frames.iter().any(|f| f.directive);
        let sd = deps.reactive()
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
        // S2: a hidden input the call site fixes for the life of the instance is not a signal.
        let live_props = deps.props.iter().any(|p| {
            let root = p.split(['.', '[']).next().unwrap_or(p);
            !self.f.ir.fixed_props.iter().any(|f| f == root)
        });
        let prop_read = live_props && client_ok && (deps.loop_bindings.is_empty() || in_row);
        if !(self.native && (always && client_ok || sd || loop_read || prop_read)) {
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
            (Node::Text(t), _) if self.raw_text => self.out.push_str(&raw_text(t)),
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
        // Static text in <script>/<style>: browsers do not decode entities there.
        if self.raw_text
            && let Some(s) = static_text(e)
        {
            self.out.push_str(&raw_text(&s));
            return None;
        }
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
            && let Some(PropBinding::Markup(m)) = i.get(name)
        {
            self.out.push_str(&m);
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
                synthetic,
                poly,
                loc,
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
        // R34.29 (b): the polymorphic element of a call with a literal `asChild` prints as the
        // call's child element.
        let as_child = if *poly {
            self.inline.as_ref().and_then(|i| i.as_child.clone())
        } else {
            None
        };
        if let Some(call) = as_child.as_ref().and_then(|a| a.component.clone()) {
            self.as_child_component_print(attrs, sattrs, call);
            return;
        }
        let tag: &String = as_child.as_ref().map_or(tag, |a| &a.tag);
        if *synthetic && *host && root && !self.native && extra.is_none() {
            // A static root that was not one element: no wrapper, so child combinators and content
            // models (`<tr>` in `<tbody>`, `<li>`, `<option>`) see the real elements.
            self.nodes(children, schildren);
            return;
        }
        if *synthetic && *host && root && self.inline.is_none() {
            self.diagnostics.push(Diagnostic::warning(
                "fragment-root",
                "an interactive component does not return a single element, so it is wrapped in <brust-host style=\"display:contents\">; \
                 that breaks child combinators (`>`) and table/list parents (`<tbody>`, `<ul>`, `<select>`)",
                *loc,
                "return one element",
            ));
        }
        let mut open = format!("<{tag}");
        if let Some(x) = extra {
            open.push_str(x);
        }
        let model = model_pair(attrs, &self.f);
        let mut spread_body = None;
        if as_child.is_some() || attrs.iter().any(|a| matches!(a, Attr::Spread(_))) {
            let extra: &[(String, String)] = as_child.as_ref().map_or(&[], |a| &a.attrs);
            spread_body = self.spread_open(tag, attrs, sattrs, model.as_deref(), extra, &mut open);
        } else {
            for (a, sa) in attrs.iter().zip(sattrs) {
                self.attr(a, sa, tag, attrs, model.as_deref(), &mut open);
            }
        }
        if let Some(m) = &model {
            open.push_str(&format!(" x-model=\"{m}\""));
        }
        // A lone reactive slot child puts x-text on this element (Review Focus 1).
        let lone = matches!(children.as_slice(), [Node::Slot(_)]);
        let mut body = String::new();
        std::mem::swap(&mut body, &mut self.out);
        let mut text_directive = None;
        let inner_html = self.inner_html.take();
        let raw_before = self.raw_text;
        self.raw_text = tag.eq_ignore_ascii_case("script") || tag.eq_ignore_ascii_case("style");
        if lone {
            if let (Node::Slot(e), Some(se)) = (&children[0], schildren.first()) {
                text_directive = self.slot(e, Some(se), true);
            }
        } else {
            self.nodes(children, schildren);
        }
        self.raw_text = raw_before;
        std::mem::swap(&mut body, &mut self.out);
        if let Some(a) = &as_child {
            body = a.body.clone();
        } else if let Some(h) = inner_html {
            body = h;
        } else if children.is_empty()
            && let Some(b) = spread_body
        {
            // R34.15: `children` in a spread is the element's children when JSX gives none.
            body = b;
        }
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
                Some(i) => match i.get(p) {
                    Some(PropBinding::Expr(e)) => e.clone(),
                    // F234: a prop the call site omits is undefined, and `json_attr` leaves the key out: the chunk's
                    // destructuring default applies to it as in React (`null` would keep null). A written value only
                    // the client has (a function, through `x-props-bind`) keeps its `null` placeholder.
                    None if !i.client_only.contains(p) => UNDEFINED.into(),
                    _ => "none".into(),
                },
            }
        };
        let (x_data, bind) = match &self.inline_host {
            Some((d, b)) => (d.clone(), b.clone()),
            None => (ir.id.clone(), None),
        };
        let mut s = format!(" x-data=\"{x_data}\"");
        // R34.140: this component asks for its collection's items (the runtime feature loads); a `<Collection.Slot>` made
        // this instance's host the collection root.
        if ir.uses_collection {
            s.push_str(" x-collection-use=\"\"");
        }
        if let Some(i) = &self.inline
            && i.writes(crate::ir::COLLECTION_ROOT_PROP)
        {
            s.push_str(" x-collection-root=\"\"");
        }
        // A whole-props read seeds every prop.
        let dict: Vec<String> = if seed.contains("*") {
            vec![]
        } else {
            seed_tree(&seed)
                .into_iter()
                .map(|(root, node)| {
                    let base = value_of(&root);
                    // F71: a root the client reads only as a list source seeds the row fields it reads.
                    let value = match (&node, ir.client_prop_projections.get(&root)) {
                        (SeedNode::Whole, Some(paths)) => format!(
                            "(({base}) | project({}))",
                            paths
                                .iter()
                                .map(|p| jinja_string(p))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                        _ => node.jinja(&base),
                    };
                    format!("{}: {value}", jinja_string(&root))
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
                Some(i) => i.object(&[]),
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
    /// A dynamic attribute `name={value}`: its server print and, when the value reads state, its `x-bind-*` member.
    /// Shared by an element's own attributes and by a live prop the parent binds on a child's element (2b-handlers C4:
    /// one print path per attribute kind).
    fn dynamic_attr_into(
        &mut self,
        name: &str,
        value: &Expr,
        sa: &Attr,
        tag: &str,
        model: Option<&str>,
        open: &mut String,
    ) {
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
            // A literal object: no declarations, no attribute (react-dom omits an empty `style`). Otherwise lowered at
            // compile time (M3-P P7): JS object order (a repeated key keeps its first place and its LAST value, so a
            // later shorthand overrides an earlier longhand as in React), keys `style_obj_to_css` drops at render
            // (`css_key`) left out, so no per-element dict is built. Values are pure expressions, so a dropped key
            // loses nothing.
            let mut ordered: Vec<(&str, &_)> = Vec::new();
            for (k, pv) in props.iter() {
                match ordered.iter_mut().find(|(o, _)| *o == k.as_str()) {
                    Some(slot) => slot.1 = pv,
                    None => ordered.push((k.as_str(), pv)),
                }
            }
            let args: Vec<String> = ordered
                .into_iter()
                .filter(|(k, _)| brust_jinja::css_key(k))
                .flat_map(|(k, pv)| [jinja_string(k), self.jinja(pv)])
                .collect();
            if !args.is_empty() {
                open.push_str(&format!("{{{{ css_attr({}) }}}}", args.join(", ")));
            }
        } else if html == "style" {
            // A style object held in a variable or prop: the same CSS rule; an undefined/null style, or one with no
            // declarations, omits the attribute (F36, F296).
            let v = crate::lower::server_expr::with_ordered_objects(|| self.value(value));
            open.push_str(&format!("{{{{ ({v}) | style_attr }}}}"));
        } else {
            open.push_str(&dynamic_attr(&html, &v, tag));
        }
        if model.is_some() && (html == "value" || html == "checked") {
            return;
        }
        if let Some(b) = self.reactive(raw, value) {
            let paint = if html == "style" {
                Paint::Style
            } else {
                match attr_kind_of(&html, tag) {
                    AttrKind::Boolean => Paint::Bool,
                    AttrKind::Stringify => Paint::AttrStr,
                    AttrKind::Overloaded => Paint::AttrOver,
                    AttrKind::Plain => Paint::Attr,
                }
            };
            let d = self.value_member(raw.unwrap(), b, paint);
            open.push_str(&format!(" x-bind-{html}=\"{d}\""));
        }
    }

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
                if value.is_empty() && empty_url_dropped(&html, tag) {
                    // `<img src="">`: React writes nothing.
                } else if value.is_empty() && is_boolean_attr(&html) {
                    open.push_str(&format!(" {html}"));
                } else {
                    open.push_str(&format!(" {html}=\"{}\"", text(value)));
                }
            }
            Attr::Dynamic { name, value } => {
                self.dynamic_attr_into(name, value, sa, tag, model, open)
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
            // F267: the ref the caller bound on this inlined instance lands here, in the caller's scope.
            // (A static child is printed with its own printer: the binding itself says the caller is native.)
            Attr::ForwardRef => {
                if let Some(i) = &self.inline
                    && let Some(n) = i.ref_binding()
                {
                    open.push_str(&format!(" x-ref=\"{n}\""));
                }
            }
            Attr::Spread(_) => {}
            // R34.140: the item marker React prints too, and the runtime's directive that hands over the item's data.
            Attr::CollectionItem { data } => {
                open.push_str(" data-radix-collection-item=\"\"");
                let raw = match sa {
                    Attr::CollectionItem { data: sd } => raw_of(data, Some(sd)),
                    _ => None,
                };
                if let Some(b) = self.reactive_as(raw, data, true) {
                    let d = self.value_member(raw.unwrap(), b, Paint::Raw);
                    open.push_str(&format!(" x-collection-item=\"{d}\""));
                }
            }
            Attr::InnerHtml { value } => {
                // The one raw sink (`html_raw`): the element body is the value, unescaped.
                let raw = match sa {
                    Attr::InnerHtml { value: sv } => raw_of(value, Some(sv)),
                    _ => None,
                };
                self.inner_html = Some(format!("{{{{ {} | html_raw }}}}", self.value(value)));
                // A reactive value also gets `x-html` (only a compiled InnerHtml ever does).
                if let Some(b) = self.reactive(raw, value) {
                    let d = self.value_member(raw.unwrap(), b, Paint::Raw);
                    open.push_str(&format!(" x-html=\"{d}\""));
                } else {
                    // Marks the markup inert for the runtime (nothing inside is bound or mounted).
                    open.push_str(" x-raw");
                }
            }
        }
    }

    /// The opening tag's attributes of an element that carries a spread (shadcn S1.2, R34.15),
    /// with React's semantics: a later key wins (keeping the first key's position, as a JS object
    /// literal does), `key`/`ref` are not attributes, and `children` in a spread is returned as the
    /// element body (used when JSX gives none). Keys known at compile time print exactly as
    /// hand-written attributes; keys known only at render go through `spread_attrs` (brust-jinja,
    /// the same rules). An own attribute replaced by a later key is still printed into a scratch
    /// buffer, so the members it records keep their numbers in every instance.
    fn spread_open(
        &mut self,
        tag: &str,
        attrs: &[Attr],
        sattrs: &[Attr],
        model: Option<&str>,
        extra: &[(String, String)],
        open: &mut String,
    ) -> Option<String> {
        enum It {
            Own(usize),
            Bound(String, PropBinding),
            Runtime(String),
            /// A forwarded event handler: the React key and the directive value.
            Handler(String, String),
            /// A live value the parent bound itself: the React key and the finished attribute text.
            Live(String, String),
        }
        // Attributes merge on the HTML attribute they print as (review F1): `className` and
        // `class`, `htmlFor` and `for`, `tabIndex` and `tabindex` are one key, so a later alias wins.
        let name_of = |it: &It| -> Option<String> {
            match it {
                It::Own(i) => match &attrs[*i] {
                    Attr::Static { name, .. } | Attr::Dynamic { name, .. } => Some(name.clone()),
                    _ => None,
                },
                It::Bound(k, _) | It::Handler(k, _) | It::Live(k, _) => Some(k.clone()),
                It::Runtime(_) => None,
            }
        };
        let key_of = |it: &It| name_of(it).map(|n| brust_jinja::spread::attr_key(&n));
        let mut items: Vec<It> = Vec::new();
        let mut children: Vec<Seg> = Vec::new();
        for (i, a) in attrs.iter().enumerate() {
            let Attr::Spread(v) = a else {
                items.push(It::Own(i));
                continue;
            };
            for s in self.spread_segs(v) {
                match s {
                    Seg::Spread(d) => {
                        children.push(Seg::Spread(d.clone()));
                        items.push(It::Runtime(d));
                    }
                    Seg::Named(k, b) => {
                        if k == "children" {
                            children.push(Seg::Named(k, b));
                        } else if let PropBinding::Handler(d) = b {
                            items.push(It::Handler(k, d));
                        } else if let PropBinding::Live(text) = b {
                            items.push(It::Live(k, text));
                        } else if k == "key"
                            || k == "ref"
                            || (k.starts_with("on")
                                && k[2..].starts_with(|c: char| c.is_ascii_uppercase()))
                        {
                            // Not attributes (a function value reaches here only as a handler the
                            // parent hoisted, above; it refuses any other, `passes/children.rs`).
                        } else if k.to_ascii_lowercase().starts_with("x-") {
                            self.diagnostics.push(Diagnostic::warning(
                                "reserved-attr",
                                format!("`{k}` reaches <{tag}> through a spread: `x-` attributes are reserved for brust's runtime and are not rendered"),
                                0,
                                "rename it (`data-x-…`) or move this component to React",
                            ));
                        } else if k == "dangerouslySetInnerHTML" {
                            self.diagnostics.push(Diagnostic::error(
                                "spread-innerhtml",
                                format!("dangerouslySetInnerHTML reaches <{tag}> through a spread"),
                                0,
                                "set dangerouslySetInnerHTML on the element itself",
                            ));
                        } else {
                            items.push(It::Bound(k, b));
                        }
                    }
                }
            }
        }
        // R34.30: the child's attributes of an `asChild` call come last, so they win; `className`
        // joins the component's (slot first) and `style` objects merge, as Radix's `Slot` does.
        for (k, e) in extra {
            let key = brust_jinja::spread::attr_key(k);
            let merge = match key.as_str() {
                "class" => Some("class_join"),
                "style" => Some("spread_merge"),
                _ => None,
            };
            let mut value = e.clone();
            if let Some(f) = merge {
                let earlier = items
                    .iter()
                    .rev()
                    .find(|it| key_of(it).as_deref() == Some(key.as_str()));
                let prior = earlier.and_then(|it| match it {
                    It::Own(i) => match &attrs[*i] {
                        Attr::Static { value, .. } => Some(jinja_string(value)),
                        Attr::Dynamic { value, .. } => Some(self.value(value)),
                        _ => None,
                    },
                    It::Bound(_, PropBinding::Expr(p)) => Some(p.clone()),
                    _ => None,
                });
                if let Some(p) = prior {
                    value = format!("{f}({p}, {e})");
                } else if earlier.is_some() || items.iter().any(|it| matches!(it, It::Runtime(_))) {
                    self.diagnostics.push(Diagnostic::error(
                        "slot-merge",
                        format!("`{k}` of the <{tag}> element cannot be merged with the child's at compile time"),
                        0,
                        "report this compiler bug (check_poly keeps this case on React)",
                    ));
                }
            }
            items.push(It::Bound(k.clone(), PropBinding::Expr(value)));
        }
        let children_body = {
            let probe = Inline {
                segs: children,
                bind: None,
                slots: String::new(),
                slot_loops: Vec::new(),
                suffix: String::new(),
                as_child: None,
                folded: None,
                rename: Default::default(),
                client_only: Vec::new(),
            };
            match probe.get("children") {
                Some(PropBinding::Markup(m)) => Some(m),
                Some(PropBinding::Expr(e)) => Some(format!("{{{{ spread_children({e}) }}}}")),
                Some(PropBinding::Handler(_) | PropBinding::Live(_) | PropBinding::Ref(_))
                | None => None,
            }
        };
        let last_runtime = items.iter().rposition(|it| matches!(it, It::Runtime(_)));
        let (head, tail) = match last_runtime {
            Some(p) => items.split_at(p + 1),
            None => items.split_at(0),
        };
        // Keys the tail sets: they win over everything before.
        let mut tail_keys: Vec<String> = tail.iter().filter_map(key_of).collect();
        tail_keys.dedup();
        let tail_names: Vec<String> = tail.iter().filter_map(name_of).collect();
        let overridden = |name: &str| tail_keys.contains(&brust_jinja::spread::attr_key(name));
        if last_runtime.is_some() {
            let mut segs: Vec<String> = Vec::new();
            for it in head {
                match it {
                    It::Own(i) => match (&attrs[*i], &sattrs[*i]) {
                        (Attr::Static { name, value }, _) => {
                            if overridden(name) {
                                continue;
                            }
                            let v = if value.is_empty() {
                                "true".to_string()
                            } else {
                                jinja_string(value)
                            };
                            segs.push(format!("[{}, {v}]", jinja_string(name)));
                        }
                        (Attr::Dynamic { name, value }, Attr::Dynamic { value: sv, .. }) => {
                            let raw = raw_of(value, Some(sv));
                            if self.reactive(raw, value).is_some() {
                                // Its member is recorded either way (numbering, see above).
                                let mut scratch = String::new();
                                self.attr(&attrs[*i], &sattrs[*i], tag, attrs, model, &mut scratch);
                                // Reactive only through props: with keys known only at render the
                                // props are the route's (fixed), or the parent refuses a live prop
                                // next to the spread (`passes/children.rs`), so the merged server
                                // value is final and needs no binding.
                                let live =
                                    raw.is_some_and(|r| self.f.deps(r, &self.scope()).reactive());
                                if overridden(name) || !live {
                                    if !overridden(name) {
                                        let v = self.value(value);
                                        segs.push(format!("[{}, {v}]", jinja_string(name)));
                                    }
                                    continue;
                                }
                                self.diagnostics.push(Diagnostic::error(
                                    "spread-shape",
                                    format!("`{name}` on <{tag}> changes on the client, but a later spread of keys known only at render may replace it"),
                                    0,
                                    "write the attribute after the spread",
                                ));
                                continue;
                            }
                            if overridden(name) {
                                continue;
                            }
                            let v = self.value(value);
                            segs.push(format!("[{}, {v}]", jinja_string(name)));
                        }
                        // Events, refs and inner HTML are not keys of the merge.
                        (a, sa) => self.attr(a, sa, tag, attrs, model, open),
                    },
                    It::Bound(k, PropBinding::Expr(e)) if !overridden(k) => {
                        segs.push(format!("[{}, {e}]", jinja_string(k)));
                    }
                    It::Bound(..) => {}
                    // A map known only at render never carries a function (it is data).
                    It::Handler(k, d) if !overridden(k) => {
                        self.handler_attr(k, d, tag, attrs, open)
                    }
                    It::Handler(..) => {}
                    // The component's own rest cannot carry the key (`shadowed_props`), so the live value is final.
                    It::Live(k, text) if !overridden(k) => open.push_str(text),
                    It::Live(..) => {}
                    It::Runtime(d) => segs.push(if tail_names.is_empty() {
                        d.clone()
                    } else {
                        let names: Vec<String> =
                            tail_names.iter().map(|n| jinja_string(n)).collect();
                        format!("(({d}) | omit_attrs([{}]))", names.join(", "))
                    }),
                }
            }
            open.push_str(&format!("{{{{ spread_attrs({}) }}}}", segs.join(", ")));
        }
        // Compile-time part: JS object semantics over the tail (the whole list when every key is known).
        let mut order: Vec<(Option<String>, usize)> = Vec::new();
        for (n, it) in tail.iter().enumerate() {
            match key_of(it) {
                Some(k) => match order
                    .iter_mut()
                    .find(|(o, _)| o.as_deref() == Some(k.as_str()))
                {
                    Some(slot) => {
                        // Replaced: still printed (into scratch) so its members keep their numbers.
                        let old = std::mem::replace(&mut slot.1, n);
                        if let It::Own(i) = &tail[old] {
                            let mut scratch = String::new();
                            self.attr(&attrs[*i], &sattrs[*i], tag, attrs, model, &mut scratch);
                        }
                    }
                    None => order.push((Some(k), n)),
                },
                None => order.push((None, n)),
            }
        }
        for (_, n) in order {
            match &tail[n] {
                It::Own(i) => self.attr(&attrs[*i], &sattrs[*i], tag, attrs, model, open),
                It::Bound(k, PropBinding::Expr(e)) => self.bound_attr(k, e, tag, open),
                It::Handler(k, d) => self.handler_attr(k, d, tag, attrs, open),
                It::Live(_, text) => open.push_str(text),
                It::Bound(..) | It::Runtime(_) => {}
            }
        }
        children_body
    }

    /// The binding of a handler the parent hoisted (shadcn S1.3): `x-on-<event>` naming the parent's
    /// member, exactly what the hand-written attribute prints in the parent.
    fn handler_attr(&mut self, k: &str, d: &str, tag: &str, attrs: &[Attr], open: &mut String) {
        // The analysis hoists valid names only; never print anything else into the tag.
        if !crate::analyze::passes::children::handler_key_ok(k) {
            return;
        }
        let Some(event) = crate::analyze::jsx::event_name(k) else {
            return;
        };
        let ev = dom_event(&event, tag, attrs);
        open.push_str(&format!(" x-on-{ev}=\"{d}\""));
    }

    /// One attribute a known-shape spread brings (`k` a React name, `v` a jinja expression of the
    /// call site): the rules of a hand-written `Attr::Dynamic` without a compile-time value.
    fn bound_attr(&mut self, k: &str, v: &str, tag: &str, open: &mut String) {
        let html = attr_name(k);
        if !brust_jinja::spread::attr_name_ok(k) || !brust_jinja::spread::attr_name_ok(&html) {
            self.diagnostics.push(Diagnostic::warning(
                "unsafe-attr",
                format!("`{k}` reaches <{tag}> through a spread but is not a valid attribute name; it is not rendered"),
                0,
                "pass attribute names only",
            ));
            return;
        }
        if is_refused_attr(&html) {
            self.refuse(&html, tag);
            return;
        }
        if html == "style" {
            open.push_str(&format!("{{{{ ({v}) | style_attr }}}}"));
        } else {
            open.push_str(&dynamic_attr(&html, v, tag));
        }
    }

    fn refuse(&mut self, html: &str, tag: &str) {
        self.diagnostics.push(Diagnostic::warning(
            "unsafe-attr",
            format!("`{html}` on <{tag}> is not rendered (inline handlers, srcdoc, `x-html` and unsafe URLs are refused)"),
            0,
            "use an event prop (onClick) and http(s)/relative URLs",
        ));
    }

    fn if_node(&mut self, n: &Node, s: &Node) {
        let (
            Node::If {
                cond, then, else_, ..
            },
            Node::If {
                cond: sc,
                then: st,
                else_: se,
                ..
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
        // F96d: a linked child's props change on the client (x-props-bind), so a list over a prop
        // is reactive, exactly as `x-text` over a prop is (`reactive`). A route component's props
        // are fixed: its prop-fed lists stay plain rows.
        // F325: rows over module-level data (an import, a module const) count no prop as changing, here or in any
        // list inside them, so a constant caller's page ships no more of that data than before (F319's freeze).
        let module = self.frames.iter().any(|fr| fr.module)
            || src_raw
                .as_ref()
                .is_some_and(|r| module_source(&self.f.deps(r, &self.scope())));
        let directive_row = self.native
            && (src_raw
                .as_ref()
                .is_some_and(|r| self.f.deps(r, &self.scope()).reactive())
                || ((self.ctx.linked)(&self.f.ir.id)
                    && self.reactive(src_raw.as_ref(), source).is_some())
                || body.iter().any(|b| needs_directives(b, &self.f, !module)));
        let var = {
            let own = self.seeds.of(self.f.ir);
            let root = self.seeds.of(self.inst_ir);
            loop {
                let v = self.loop_var.get() + 1;
                self.loop_var.set(v);
                let var = format!("_i{v}");
                if !self.jinja_taken(&var, &own, &root) {
                    break var;
                }
            }
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
            var_used: Rc::new(Cell::new(false)),
            // An `x-for` bind names the index in the row's directive.
            index_used: Cell::new(!x_for.is_empty() && index.is_some()),
            directive: !x_for.is_empty(),
            module,
        });
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
        let frame = self.frames.pop();
        // The row is built first: only a variable it read gets a `set`.
        let mut sets = String::new();
        if let Some(f) = &frame {
            if f.var_used.get() {
                sets.push_str(&format!("{{% set {var} = loop.index0 %}}"));
            }
            if let (Some(i), true) = (index, f.index_used.get()) {
                sets.push_str(&format!("{{% set {i}{} = loop.index0 %}}", self.suffix()));
            }
        }
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
        let Node::Component {
            name, tier, link, ..
        } = n
        else {
            return false;
        };
        // Only a static, unlinked child (no `x-data` host): a host root that carries `x-for`
        // breaks when the child's chunk registers before the parent's (its own instance would
        // bind the row directive), so a host row keeps the `<brust-row>` wrapper.
        if !matches!(tier, Tier::Static) || link.is_some() {
            return false;
        }
        let Some(child) = self.f.ir.children.iter().find(|c| &c.name == name) else {
            return false;
        };
        let id = child.id.clone().unwrap_or_else(|| name.clone());
        (self.ctx.resolve)(&id).is_some_and(|c| {
            matches!(
                c.template,
                Node::Element {
                    synthetic: false,
                    ..
                }
            )
        })
    }

    /// Whether `n` (or anything below it) is an inlined component with a job or `useId` values.
    fn has_fed(&self, n: &Node) -> bool {
        if let Node::Component { name, .. } = n
            && let Some(c) = self.f.ir.children.iter().find(|c| &c.name == name)
            && let Some(ir) = (self.ctx.resolve)(&c.id.clone().unwrap_or_else(|| name.clone()))
            && is_fed(ir)
        {
            return true;
        }
        match n {
            Node::Element { children, .. }
            | Node::Component { children, .. }
            | Node::Fragment(children) => children.iter().any(|c| self.has_fed(c)),
            Node::If { then, else_, .. } => then.iter().chain(else_).any(|c| self.has_fed(c)),
            Node::For { body, .. } => body.iter().any(|c| self.has_fed(c)),
            Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
        }
    }

    /// The props a component call passes, as the segments its inlined template reads (printed in this scope).
    fn call_segs(
        &mut self,
        loc: u32,
        name: &str,
        props: &[(String, Expr)],
        sprops: &[(String, Expr)],
    ) -> (Vec<Seg>, Vec<String>) {
        let loc = &loc;
        let ir = self.f.ir;
        let mut segs = Vec::new();
        let mut client_only = Vec::new();
        for (pname, v) in props.iter() {
            if pname == crate::ir::COLLECTION_ITEM_PROP {
                continue;
            }
            if pname == crate::ir::SPREAD_KEY {
                segs.extend(self.spread_segs(v));
                continue;
            }
            // F267: the parent's ref cell, bound where the child's own `ref={forwardedRef}` is.
            if pname == "ref"
                && ir
                    .live_forwards
                    .iter()
                    .any(|f| f.loc == *loc && f.key == "ref")
                && let Expr::Raw(RawExpr {
                    kind: RawKind::Ident { name: cell, .. },
                    ..
                }) = v
            {
                segs.push(Seg::Named(pname.clone(), PropBinding::Ref(cell.clone())));
                continue;
            }
            let forwarded = ir.handlers.iter().find(|h| {
                h.forwarded
                    .as_ref()
                    .is_some_and(|f| f.loc == *loc && &f.key == pname)
            });
            if let Some(h) = forwarded {
                let d = directive(&h.name, &h.item_scoped);
                segs.push(Seg::Named(pname.clone(), PropBinding::Handler(d)));
                continue;
            }
            // A live value the parent binds on the child's element (2b-handlers): printed here, in this
            // component's scope, like an attribute written on that element.
            if ir
                .live_forwards
                .iter()
                .any(|f| f.loc == *loc && &f.key == pname)
            {
                let sv = sprops
                    .iter()
                    .find(|(k, _)| k == pname)
                    .map(|(_, e)| e.clone());
                if let Some(sv) = sv {
                    let mut text = String::new();
                    let sa = Attr::Dynamic {
                        name: pname.clone(),
                        value: sv,
                    };
                    self.dynamic_attr_into(pname, v, &sa, name, None, &mut text);
                    segs.push(Seg::Named(pname.clone(), PropBinding::Live(text)));
                    continue;
                }
            }
            if matches!(v, Expr::ClientOnly { .. }) {
                client_only.push(pname.clone());
                continue;
            }
            // a `style` object keeps its source order (F296 C3), like a style written on the element
            let value = if pname == "style" {
                crate::lower::server_expr::with_ordered_objects(|| self.value(v))
            } else {
                self.value(v)
            };
            segs.push(Seg::Named(pname.clone(), PropBinding::Expr(value)));
        }
        (segs, client_only)
    }

    /// `extra`: attributes for the child's root element (a list-row directive).
    fn component(&mut self, n: &Node, s: &Node, extra: Option<&str>) {
        let (
            Node::Component {
                loc,
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
        let slot_loops: Vec<Rc<Cell<bool>>> =
            self.frames.iter().map(|f| f.var_used.clone()).collect();
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
            if per_item && (self.inline.is_some() || self.frames.len() > 1) {
                // S6 hands the server one array per ssr job, indexed by ONE list of the route
                // component; deeper loops, or a row of an inlined child (whose output already sits
                // in the instance's slot dict), need a 2-D slot.
                self.diagnostics.push(Diagnostic::error(
                    "nested-instance",
                    format!(
                        "<{name}> has a job or useId and sits inside nested lists or an inlined component"
                    ),
                    0,
                    "flatten the lists or render the child per row in its own component (ledger F53)",
                ));
                return;
            }
            let idx = if per_item {
                self.frames.iter().for_each(|f| f.var_used.set(true));
                loops.as_str()
            } else {
                ""
            };
            // Inside an inlined child the render is that instance's job output (L4): it sits in
            // the instance's slot dict like a precompute value.
            let html = match self.inline {
                Some(_) => self.slot_ref(&out, false),
                None => format!("{out}{idx}"),
            };
            let dict = self.props_dict(props, sprops);
            self.out.push_str(&crate::lower::island_host(
                &id,
                &dict,
                &format!("{{{{ {html} | safe }}}}"),
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
        // A static wrapper's fed child was re-based onto the component the instance records belong to (analysis,
        // `children.rs` rebase): its record is there, numbered with the shared counter.
        let rebased = {
            let next = self.instances.get(&id).copied().unwrap_or(0) + 1;
            self.inst_ir
                .instances
                .iter()
                .any(|r| r.child_id == id && r.k == next)
        };
        // R34.96: a fed child whose job runs inside this component's own job (analysis `ir.fused`).
        let fused = ir.fused.iter().find(|f| f.child_id == id && f.loc == *loc);
        if self.inline.is_some() && is_fed(child_ir) && !rebased && fused.is_none() {
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
        if self.frames.len() > 1 && is_fed(child_ir) {
            // S6 hands the server one array per instance, indexed by ONE list.
            self.diagnostics.push(Diagnostic::error(
                "nested-instance",
                format!("<{name}> has a job or useId and sits inside nested lists"),
                0,
                "flatten the lists or render the child per row in its own component (ledger F53)",
            ));
            return;
        }
        if !children.is_empty()
            && contains_node(&child_ir.template, &|n| matches!(n, Node::For { .. }))
            && children.iter().any(|c| self.has_fed(c))
        {
            // Slot content is printed once and pasted per row: its ids/jobs would repeat.
            self.diagnostics.push(Diagnostic::error(
                "nested-instance",
                format!("children with a job or useId are passed to <{name}>, which repeats them in a list"),
                0,
                "render the child inside the repeating component (ledger F53)",
            ));
            return;
        }
        // A fused instance has no record, so it takes no record number (k).
        let k = match fused {
            Some(_) => 0,
            None => {
                let k = self.instances.entry(id.clone()).or_insert(0);
                *k += 1;
                *k
            }
        };
        let as_child = match &child_ir.poly {
            Some(poly) if slot_selected(poly, props) => self.as_child_of(name, children, schildren),
            _ => None,
        };
        // F328b: the item markers a `<Collection.ItemSlot>` over this component asks for, printed in THIS scope on the
        // child's root element (the same data the element form prints; the child never reads the prop).
        let item_extra: Option<String> = props
            .iter()
            .zip(sprops)
            .find(|((k, _), _)| k == crate::ir::COLLECTION_ITEM_PROP)
            .map(|((_, data), (_, sd))| {
                let mut open = String::from(" data-radix-collection-item=\"\"");
                let raw = raw_of(data, Some(sd));
                if let Some(b) = self.reactive_as(raw, data, true) {
                    let d = self.value_member(raw.unwrap(), b, Paint::Raw);
                    open.push_str(&format!(" x-collection-item=\"{d}\""));
                }
                open
            });
        let (mut segs, client_only) = self.call_segs(*loc, name, props, sprops);
        if as_child.is_none() && !children.is_empty() {
            let mut saved = String::new();
            std::mem::swap(&mut saved, &mut self.out);
            self.nodes(children, schildren);
            std::mem::swap(&mut saved, &mut self.out);
            segs.push(Seg::Named("children".into(), PropBinding::Markup(saved)));
        }
        let bind = link
            .and_then(|l| ir.child_links.iter().find(|c| c.id == l))
            .map(|l| {
                let name = {
                    let taken = self.seeds.of(ir);
                    let mut name = l.props_member.clone();
                    let mut n = 0;
                    while taken.contains(&name) {
                        n += 1;
                        name = format!("{}_{n}", l.props_member);
                    }
                    name
                };
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
        // A row-invariant instance (F142, R34.42) is fed once: its record has no loops, and its
        // slot is read without the row index.
        let invariant = self
            .inst_ir
            .instances
            .iter()
            .any(|r| r.child_id == id && r.k == k && r.loops.is_empty());
        let (loops, slot_loops) = if invariant {
            (String::new(), Vec::new())
        } else {
            (loops, slot_loops)
        };
        // The server numbers an instance by its record's position among this child's records
        // (brust-core `pipeline.rs` ordinal); an instance the build evaluated has no record (F149),
        // so the ones after it move up.
        let ordinal = self
            .inst_ir
            .instances
            .iter()
            .filter(|r| r.child_id == id && r.k <= k)
            .count();
        let inline = match fused {
            // Read through this component's own slot dict and folded values (A2).
            Some(f) => {
                let (slots, slot_loops, folded) = match &self.inline {
                    Some(i) => (i.slots.clone(), i.slot_loops.clone(), i.folded.clone()),
                    None => (String::new(), Vec::new(), None),
                };
                // This component may itself be fused into its own parent: its output names are then
                // renamed once more there, so the child's names go through this frame's rename too.
                let outer = self.inline.as_ref().map(|i| &i.rename);
                let rename = f
                    .outputs
                    .iter()
                    .map(|(slot, out)| {
                        let out = outer.and_then(|r| r.get(out)).unwrap_or(out);
                        (slot.clone(), out.clone())
                    })
                    .collect();
                Inline {
                    segs,
                    bind: bind.clone(),
                    slots,
                    slot_loops,
                    suffix: format!("_f{}{}", short(&id), f.ordinal),
                    as_child,
                    folded,
                    rename,
                    client_only,
                }
            }
            None => Inline {
                segs,
                bind: bind.clone(),
                slots: format!("__{id}_{ordinal}{loops}"),
                slot_loops,
                suffix: format!("_{}{k}", short(&id)),
                as_child,
                folded: self
                    .inst_ir
                    .folded_instances
                    .iter()
                    .find(|f| f.child_id == id && f.k == k)
                    .map(|f| f.values.clone()),
                rename: Default::default(),
                client_only,
            },
        };
        let Some(mut p) = Printer::new(
            child_ir,
            self.ctx,
            Some(inline),
            self.loop_var,
            self.seeds.clone(),
        ) else {
            return;
        };
        p.blank = self.blank;
        // The inlined component numbers its fed children with this printer's counters (F164 re-base).
        p.inst_ir = self.inst_ir;
        p.instances = std::mem::take(&mut self.instances);
        p.native = !matches!(child_ir.tier, Tier::Static) || bind.is_some();
        p.inline_host = Some((child_ir.id.clone(), bind));
        p.preamble();
        let (ct, cs) = (&child_ir.template, &p.f.structural.template);
        let extra = match (extra, item_extra) {
            (Some(x), Some(i)) => Some(format!("{x}{i}")),
            (Some(x), None) => Some(x.to_string()),
            (None, i) => i,
        };
        match extra.as_deref() {
            Some(x) => p.element(ct, cs, true, Some(x)),
            None => p.node(ct, cs, true),
        }
        self.out.push_str(&p.out);
        self.diagnostics.append(&mut p.diagnostics);
        self.instances = std::mem::take(&mut p.instances);
    }

    /// The child element of a call with a literal `asChild` (R34.29 b), printed in this scope. The
    /// analysis (`passes/children.rs` `check_poly`) keeps every other shape on React, so a
    /// mismatch here is a compiler bug.
    fn as_child_of(
        &mut self,
        name: &str,
        children: &[Node],
        schildren: &[Node],
    ) -> Option<AsChild> {
        if matches!(children, [Node::Component { .. }]) {
            return self.as_child_component(children, schildren);
        }
        let (
            [
                Node::Element {
                    tag,
                    attrs,
                    children: kids,
                    ..
                },
            ],
            [
                Node::Element {
                    children: skids, ..
                },
            ],
        ) = (children, schildren)
        else {
            self.diagnostics.push(Diagnostic::error(
                "lower-shape",
                format!("<{name}> with `asChild` does not have one element child"),
                0,
                "report this compiler bug",
            ));
            return None;
        };
        let attrs = attrs
            .iter()
            .filter_map(|a| match a {
                Attr::Static { name, value } => {
                    let v = if value.is_empty() && is_boolean_attr(&attr_name(name)) {
                        "true".to_string()
                    } else {
                        jinja_string(value)
                    };
                    Some((name.clone(), v))
                }
                Attr::Dynamic { name, value } => Some((name.clone(), self.value(value))),
                _ => None,
            })
            .collect();
        let mut body = String::new();
        std::mem::swap(&mut body, &mut self.out);
        self.nodes(kids, skids);
        std::mem::swap(&mut body, &mut self.out);
        Some(AsChild {
            tag: tag.clone(),
            attrs,
            body,
            component: None,
        })
    }

    /// F363a: the static component child of a call with a literal `asChild`, its props bound in THIS scope. The analysis
    /// (`check_poly_component`) keeps every other shape on React, so a mismatch here is a compiler bug.
    fn as_child_component(&mut self, children: &[Node], schildren: &[Node]) -> Option<AsChild> {
        let (
            [
                Node::Component {
                    loc,
                    name,
                    props,
                    children: kids,
                    ..
                },
            ],
            [
                Node::Component {
                    props: sprops,
                    children: skids,
                    ..
                },
            ],
        ) = (children, schildren)
        else {
            return None;
        };
        let shape = |this: &mut Self, why: String| {
            this.diagnostics.push(Diagnostic::error(
                "lower-shape",
                why,
                0,
                "report this compiler bug",
            ));
            None
        };
        let Some(c) = self.f.ir.children.iter().find(|c| &c.name == name) else {
            return shape(self, format!("<{name}> under `asChild` is not a child"));
        };
        let id = c.id.clone().unwrap_or_else(|| name.clone());
        let Some(child_ir) = (self.ctx.resolve)(&id) else {
            return shape(self, format!("child <{name}> ({id}) was not compiled"));
        };
        if !matches!(child_ir.tier, Tier::Static) || is_fed(child_ir) {
            return shape(
                self,
                format!("<{name}> under `asChild` is not a plain static component"),
            );
        }
        let k = {
            let k = self.instances.entry(id.clone()).or_insert(0);
            *k += 1;
            *k
        };
        let (mut segs, client_only) = self.call_segs(*loc, name, props, sprops);
        if !kids.is_empty() {
            let mut saved = String::new();
            std::mem::swap(&mut saved, &mut self.out);
            self.nodes(kids, skids);
            std::mem::swap(&mut saved, &mut self.out);
            segs.push(Seg::Named("children".into(), PropBinding::Markup(saved)));
        }
        Some(AsChild {
            tag: String::new(),
            attrs: Vec::new(),
            body: String::new(),
            component: Some(ChildCall {
                id,
                k,
                segs,
                client_only,
            }),
        })
    }

    /// F363a: the polymorphic element replaced by the child component, which is given the element's attributes as props
    /// (React's Slot: `cloneElement(child, mergeProps(slotProps, child.props))`): the child's own props come last and win,
    /// except `className`, which joins (the element's first).
    fn as_child_component_print(&mut self, attrs: &[Attr], sattrs: &[Attr], call: ChildCall) {
        let mut mine: Vec<Seg> = Vec::new();
        let push = |mine: &mut Vec<Seg>, seg: Seg| {
            // a later key replaces an earlier one (a JS object literal), on the attribute they print as
            if let Seg::Named(k, _) = &seg {
                let key = brust_jinja::spread::attr_key(k);
                mine.retain(
                    |s| !matches!(s, Seg::Named(o, _) if brust_jinja::spread::attr_key(o) == key),
                );
            }
            mine.push(seg);
        };
        for (a, sa) in attrs.iter().zip(sattrs) {
            match a {
                Attr::Static { name, value } => {
                    let v = if value.is_empty() && is_boolean_attr(&attr_name(name)) {
                        "true".to_string()
                    } else {
                        jinja_string(value)
                    };
                    push(&mut mine, Seg::Named(name.clone(), PropBinding::Expr(v)));
                }
                Attr::Dynamic { name, value } => {
                    let v = self.value(value);
                    push(&mut mine, Seg::Named(name.clone(), PropBinding::Expr(v)));
                }
                Attr::Spread(v) => {
                    for seg in self.spread_segs(v) {
                        match &seg {
                            Seg::Named(k, _) if k == "children" || k == "key" || k == "ref" => {}
                            _ => push(&mut mine, seg),
                        }
                    }
                }
                _ => {
                    let _ = sa;
                    self.diagnostics.push(Diagnostic::error(
                        "lower-shape",
                        "the element an `asChild` component child replaces has a directive"
                            .to_string(),
                        0,
                        "report this compiler bug (check_poly_component keeps this case on React)",
                    ));
                    return;
                }
            }
        }
        let mut theirs = call.segs;
        // className joins: the element's first, then the child's
        let class_of = |segs: &[Seg]| {
            segs.iter().position(
                |s| matches!(s, Seg::Named(k, _) if brust_jinja::spread::attr_key(k) == "class"),
            )
        };
        if let (Some(i), Some(j)) = (class_of(&mine), class_of(&theirs))
            && let (Seg::Named(_, PropBinding::Expr(a)), Seg::Named(k, PropBinding::Expr(b))) =
                (mine[i].clone(), theirs[j].clone())
        {
            mine.remove(i);
            theirs[j] = Seg::Named(k, PropBinding::Expr(format!("class_join({a}, {b})")));
        }
        mine.extend(theirs);
        let id = call.id;
        let Some(child_ir) = (self.ctx.resolve)(&id) else {
            return;
        };
        let inline = Inline {
            segs: mine,
            bind: None,
            slots: format!("__{id}_0"),
            slot_loops: Vec::new(),
            suffix: format!("_{}{}", short(&id), call.k),
            as_child: None,
            folded: None,
            rename: Default::default(),
            client_only: call.client_only,
        };
        let Some(mut p) = Printer::new(
            child_ir,
            self.ctx,
            Some(inline),
            self.loop_var,
            self.seeds.clone(),
        ) else {
            return;
        };
        p.blank = self.blank;
        p.inst_ir = self.inst_ir;
        p.instances = std::mem::take(&mut self.instances);
        p.native = false;
        p.inline_host = Some((child_ir.id.clone(), None));
        p.preamble();
        p.node(&child_ir.template, &p.f.structural.template, true);
        self.out.push_str(&p.out);
        self.diagnostics.append(&mut p.diagnostics);
        self.instances = std::mem::take(&mut p.instances);
    }

    /// The props a spread `{...v}` passes (R34.15): this component's own props object (or its
    /// `...rest`) is its call site's segments when it is inlined, the render's `_props` at the
    /// root; a props path is one object of unknown keys.
    fn spread_segs(&self, v: &Expr) -> Vec<Seg> {
        let raw = match v {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => Some(r),
            _ => None,
        };
        let omit = match raw.map(|r| &r.kind) {
            Some(RawKind::Ident {
                name,
                kind: IdentKind::Prop,
            }) if name == "*" => Some(Vec::new()),
            Some(RawKind::Ident {
                name,
                kind: IdentKind::Prop,
            }) if name == crate::ir::REST_PROPS => Some(self.rest_omits()),
            _ => None,
        };
        match (omit, &self.inline) {
            (Some(omit), Some(i)) => i
                .segs
                .iter()
                .filter_map(|s| match s {
                    Seg::Named(k, _) if omit.contains(k) => None,
                    Seg::Named(..) => Some(s.clone()),
                    Seg::Spread(d) => Some(Seg::Spread(omit_jinja(d, &omit))),
                })
                .collect(),
            (Some(omit), None) => vec![Seg::Spread(omit_jinja("_props", &omit))],
            (None, _) => vec![Seg::Spread(format!("({})", self.value(v)))],
        }
    }

    /// The keys this component's props pattern names: what its `...rest` leaves out.
    fn rest_omits(&self) -> Vec<String> {
        self.f.ir.props.iter().map(|p| p.name.clone()).collect()
    }

    fn props_dict(&self, props: &[(String, Expr)], _s: &[(String, Expr)]) -> String {
        let items: Vec<String> = props
            .iter()
            .filter(|(_, v)| !matches!(v, Expr::ClientOnly { .. }))
            // F282: an object literal crosses as JSON in source order, as `JSON.stringify` writes it
            .map(|(k, v)| {
                format!(
                    "{}: {}",
                    jinja_string(k),
                    crate::lower::server_expr::with_ordered_objects(|| self.value(v))
                )
            })
            .collect();
        format!("{{{}}}", items.join(", "))
    }
}

/// Whether the call's props select the Slot of a polymorphic tag: a literal `asChild` (compared
/// with `negate`). Anything else is the host element; the analysis refuses a non-literal.
fn slot_selected(poly: &crate::ir::PolyTag, props: &[(String, Expr)]) -> bool {
    let flag = props
        .iter()
        .rev()
        .find(|(k, _)| k == &poly.flag)
        .and_then(|(_, v)| match v {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => match r.json_literal() {
                Some(serde_json::Value::Bool(b)) => Some(b),
                _ => None,
            },
            _ => None,
        })
        .unwrap_or(false);
    flag != poly.negate
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
            // F234: an absent (or null) value stays what it is, never a `{}` the chunk would read as given; `json_attr`
            // leaves an undefined key out.
            SeedNode::Fields(f) => format!(
                "({{{}}} if {base} is defined and {base} is not none else {base})",
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

/// Whether a list body needs `x-for` (it carries directives). `props` (F320): a prop read counts as changing.
fn needs_directives(n: &Node, f: &Facts<'_>, props: bool) -> bool {
    match n {
        Node::Element {
            attrs, children, ..
        } => {
            attrs.iter().any(|a| match a {
                Attr::Event { .. } | Attr::Ref { .. } => true,
                Attr::Dynamic { value, .. } | Attr::InnerHtml { value } => {
                    expr_reactive(value, f, props)
                }
                _ => false,
            }) || children.iter().any(|c| needs_directives(c, f, props))
        }
        Node::Slot(e) => expr_reactive(e, f, props),
        Node::If {
            cond, then, else_, ..
        } => {
            expr_reactive(cond, f, props)
                || then
                    .iter()
                    .chain(else_)
                    .any(|c| needs_directives(c, f, props))
        }
        Node::For { body, source, .. } => {
            let props = props
                && !matches!(source, Expr::Server(ServerExpr(r)) if module_source(&f.deps(r, &[])));
            expr_reactive(source, f, props) || body.iter().any(|c| needs_directives(c, f, props))
        }
        Node::Component {
            loc,
            link,
            children,
            ..
        } => {
            // A handler the parent hoisted from this instance is bound on the child's element.
            link.is_some()
                || f.ir
                    .handlers
                    .iter()
                    .any(|h| h.forwarded.as_ref().is_some_and(|w| w.loc == *loc))
                || children.iter().any(|c| needs_directives(c, f, props))
        }
        Node::Fragment(cs) => cs.iter().any(|c| needs_directives(c, f, props)),
        Node::Text(_) | Node::Outlet => false,
    }
}

/// Whether `e` changes on the client, for `needs_directives`: state, a store, or (F320) a named prop the call site does
/// not fix in a component whose props are a signal (`ComponentIR::props_are_signal`, as the analysis's row decision).
fn expr_reactive(e: &Expr, f: &Facts<'_>, props: bool) -> bool {
    match e {
        Expr::Precomputed {
            state_dependent, ..
        } => *state_dependent,
        Expr::Server(ServerExpr(r)) => {
            let d = f.deps(r, &[]);
            d.reactive()
                || props
                    && f.ir.props_are_signal()
                    && d.props.iter().any(|p| {
                        let root = p.split(['.', '[']).next().unwrap_or(p);
                        !matches!(root, "children" | "*" | REST_INPUT)
                            && !root.starts_with("__ctx_")
                            && !f.ir.fixed_props.iter().any(|x| x == root)
                            && !f.ir.seed_props.iter().any(|x| x == root)
                    })
        }
        _ => false,
    }
}

/// F325: a list source that reads module-level data (an imported binding or a module const): its rows count no prop as
/// changing (`ComponentIR::props_are_signal`), so the client chunk never imports that data for them (F319's freeze).
pub(crate) fn module_source(d: &crate::analyze::passes::deps::Deps) -> bool {
    !d.imports.is_empty() || !d.module_locals.is_empty()
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

use crate::ir::is_fed;

/// Whether `f` holds for `n` or any node below it.
fn contains_node(n: &Node, f: &dyn Fn(&Node) -> bool) -> bool {
    if f(n) {
        return true;
    }
    match n {
        Node::Element { children, .. }
        | Node::Component { children, .. }
        | Node::Fragment(children) => children.iter().any(|c| contains_node(c, f)),
        Node::If { then, else_, .. } => then.iter().chain(else_).any(|c| contains_node(c, f)),
        Node::For { body, .. } => body.iter().any(|c| contains_node(c, f)),
        Node::Text(_) | Node::Slot(_) | Node::Outlet => false,
    }
}

/// Text for a raw-text element (`<script>`, `<style>`): printed as a jinja string, unescaped.
fn raw_text(s: &str) -> String {
    format!("{{{{ {} | safe }}}}", jinja_string(s))
}

/// The text of a literal string or substitution-free template.
fn static_text(e: &Expr) -> Option<String> {
    match e {
        Expr::Raw(r) => match &r.kind {
            RawKind::Lit(crate::ir::Literal::Str(s)) => Some(s.clone()),
            RawKind::Template { head, parts } if parts.is_empty() => Some(head.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// React omits `src=""` and `href=""` on every element but `<a>` and a custom element (which passes it through).
fn empty_url_dropped(html: &str, tag: &str) -> bool {
    matches!(html, "src" | "href") && tag != "a" && !tag.contains('-')
}

/// The kind that decides how React prints a boolean on `html` of `tag`: a custom element passes every attribute through
/// as given (`true` → `""`, `false` omits), the same as the overloaded ones; otherwise the name decides.
fn attr_kind_of(html: &str, tag: &str) -> AttrKind {
    if tag.contains('-') {
        AttrKind::Overloaded
    } else {
        attr_kind(html)
    }
}

/// A dynamic attribute on the server, by what React does with its value (`brust_jinja::attr_kind`): a boolean attribute
/// prints when truthy; `aria-*`, `data-*` and the other "booleanish string" attributes print `"true"`/`"false"`; `download`
/// and `capture` print `""` for `true`; any other attribute omits a boolean. A custom element (a tag with `-`) is React's pass-through rule for every
/// attribute: `true` is `""`, `false` omits it, anything else is its string (F213). A URL attribute also needs a safe scheme (the runtime's rule).
fn dynamic_attr(html: &str, v: &str, tag: &str) -> String {
    let mut url = if is_url_attr(html) {
        format!(" and ({v} | url_ok)")
    } else {
        String::new()
    };
    // React drops an empty `src` / `href` (it would load the page again), except on an anchor.
    if empty_url_dropped(html, tag) {
        url.push_str(&format!(" and ({v} | attr_str) != \"\""));
    }
    match attr_kind_of(html, tag) {
        AttrKind::Boolean => format!("{{% if ({v}) | truthy %}} {html}{{% endif %}}"),
        AttrKind::Overloaded => format!(
            "{{% if ({v}) | bool_true %}} {html}=\"\"{{% elif ({v}) | present{url} %}} {html}=\"{{{{ {v} | attr_str | e }}}}\"{{% endif %}}"
        ),
        AttrKind::Stringify => format!(
            "{{% if ({v} | present_str){url} %}} {html}=\"{{{{ {v} | attr_str | e }}}}\"{{% endif %}}"
        ),
        AttrKind::Plain => {
            let present = "present_plain";
            if url.is_empty() {
                format!(
                    "{{% if {v} | {present} %}} {html}=\"{{{{ {v} | attr_str | e }}}}\"{{% endif %}}"
                )
            } else {
                format!(
                    "{{% if ({v} | {present}){url} %}} {html}=\"{{{{ {v} | attr_str | e }}}}\"{{% endif %}}"
                )
            }
        }
    }
}
