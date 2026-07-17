//! Bounded compile-time expansion for literal data and pure structural JSX.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};

use swc_core::common::{DUMMY_SP, Spanned};
use swc_core::ecma::ast::*;

use crate::analyze::{Inlinability, analyze};

const MAX_EXPANSIONS: usize = 1024;
const MAX_DEPTH: usize = 32;
const MAX_BINDINGS: usize = 256;

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
    Symbol(String),
}

#[derive(Debug)]
pub(crate) struct StaticEvalError {
    pub(crate) message: String,
}

impl StaticEvalError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for StaticEvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "static evaluation: {}", self.message)
    }
}

impl std::error::Error for StaticEvalError {}

type Bindings = HashMap<String, Box<Expr>>;

pub(crate) fn expand_inline_body<'a>(
    module: &Module,
    root_name: &str,
    function: &'a Function,
) -> Result<Cow<'a, BlockStmt>, StaticEvalError> {
    let body = function
        .body
        .as_ref()
        .ok_or_else(|| StaticEvalError::new("function has no body"))?;
    let mut evaluator = Evaluator::new(module, root_name)?;
    let mut expanded = body.clone();
    let mut bindings = Bindings::new();
    for statement in &mut expanded.stmts {
        evaluator.expand_stmt(statement, &mut bindings, 0)?;
    }
    if evaluator.changed {
        Ok(Cow::Owned(expanded))
    } else {
        Ok(Cow::Borrowed(body))
    }
}

struct Evaluator<'a> {
    module_consts: HashMap<String, &'a Expr>,
    module_cache: HashMap<String, Value>,
    resolving: Vec<String>,
    imports: HashSet<String>,
    helpers: HashMap<String, &'a FnDecl>,
    helper_stack: Vec<String>,
    root_name: String,
    expansions: usize,
    bindings: usize,
    changed: bool,
}

impl<'a> Evaluator<'a> {
    fn new(module: &'a Module, root_name: &str) -> Result<Self, StaticEvalError> {
        let mut module_consts = HashMap::new();
        let mut imports = HashSet::new();
        let mut helpers = HashMap::new();

        for item in &module.body {
            match item {
                ModuleItem::ModuleDecl(ModuleDecl::Import(import)) => {
                    for spec in &import.specifiers {
                        let local = match spec {
                            ImportSpecifier::Named(spec) => &spec.local,
                            ImportSpecifier::Default(spec) => &spec.local,
                            ImportSpecifier::Namespace(spec) => &spec.local,
                        };
                        imports.insert(local.sym.to_string());
                    }
                }
                ModuleItem::Stmt(Stmt::Decl(Decl::Var(var))) if var.kind == VarDeclKind::Const => {
                    for decl in &var.decls {
                        if let Pat::Ident(binding) = &decl.name
                            && let Some(init) = &decl.init
                        {
                            module_consts.insert(binding.id.sym.to_string(), init.as_ref());
                        }
                    }
                }
                ModuleItem::Stmt(Stmt::Decl(Decl::Fn(function))) => {
                    helpers.insert(function.ident.sym.to_string(), function);
                }
                _ => {}
            }
        }

        if module_consts.len() > MAX_BINDINGS {
            return Err(StaticEvalError::new(format!(
                "binding budget exceeded (max {MAX_BINDINGS})"
            )));
        }

        Ok(Self {
            module_consts,
            module_cache: HashMap::new(),
            resolving: Vec::new(),
            imports,
            helpers,
            helper_stack: Vec::new(),
            root_name: root_name.to_string(),
            expansions: 0,
            bindings: 0,
            changed: false,
        })
    }

    fn check_depth(&self, depth: usize) -> Result<(), StaticEvalError> {
        if depth > MAX_DEPTH {
            Err(StaticEvalError::new(format!(
                "recursion depth exceeded (max {MAX_DEPTH})"
            )))
        } else {
            Ok(())
        }
    }

    fn add_binding(&mut self) -> Result<(), StaticEvalError> {
        self.bindings += 1;
        if self.bindings > MAX_BINDINGS {
            Err(StaticEvalError::new(format!(
                "binding budget exceeded (max {MAX_BINDINGS})"
            )))
        } else {
            Ok(())
        }
    }

    fn add_expansion(&mut self) -> Result<(), StaticEvalError> {
        self.expansions += 1;
        if self.expansions > MAX_EXPANSIONS {
            Err(StaticEvalError::new(format!(
                "expansion budget exceeded (max {MAX_EXPANSIONS})"
            )))
        } else {
            Ok(())
        }
    }

    fn resolve_module_const(
        &mut self,
        name: &str,
        env: &Bindings,
        depth: usize,
    ) -> Result<Value, StaticEvalError> {
        if let Some(value) = self.module_cache.get(name) {
            return Ok(value.clone());
        }
        if self.resolving.iter().any(|entry| entry == name) {
            let mut path = self.resolving.join(" -> ");
            if !path.is_empty() {
                path.push_str(" -> ");
            }
            path.push_str(name);
            return Err(StaticEvalError::new(format!("constant cycle: {path}")));
        }
        let init = (*self
            .module_consts
            .get(name)
            .ok_or_else(|| StaticEvalError::new(format!("unknown constant {name}")))?)
        .clone();
        self.resolving.push(name.to_string());
        self.add_binding()?;
        let value = self
            .eval_expr(&init, env, depth + 1)?
            .ok_or_else(|| StaticEvalError::new(format!("unsupported constant {name}")))?;
        self.resolving.pop();
        self.module_cache.insert(name.to_string(), value.clone());
        Ok(value)
    }

    fn eval_expr(
        &mut self,
        expr: &Expr,
        env: &Bindings,
        depth: usize,
    ) -> Result<Option<Value>, StaticEvalError> {
        self.check_depth(depth)?;
        match strip_paren(expr) {
            Expr::Lit(Lit::Str(value)) => Ok(Some(Value::String(
                value.value.to_string_lossy().into_owned(),
            ))),
            Expr::Lit(Lit::Bool(value)) => Ok(Some(Value::Bool(value.value))),
            Expr::Lit(Lit::Null(_)) => Ok(Some(Value::Null)),
            Expr::Lit(Lit::Num(value)) if value.value.is_finite() => {
                Ok(Some(Value::Number(value.value)))
            }
            Expr::Lit(Lit::Num(_)) => Err(StaticEvalError::new("non-finite number")),
            Expr::Ident(id) if id.sym.as_ref() == "undefined" => Ok(Some(Value::Undefined)),
            Expr::Ident(id) => {
                let name = id.sym.as_ref();
                if let Some(bound) = env.get(name) {
                    self.eval_expr(bound, env, depth + 1)
                } else if self.module_consts.contains_key(name) {
                    self.resolve_module_const(name, env, depth + 1).map(Some)
                } else if self.imports.contains(name) {
                    Ok(Some(Value::Symbol(name.to_string())))
                } else {
                    Ok(None)
                }
            }
            Expr::Array(array) => {
                let mut values = Vec::with_capacity(array.elems.len());
                for element in &array.elems {
                    let Some(element) = element else {
                        return Err(StaticEvalError::new("array holes are unsupported"));
                    };
                    if element.spread.is_some() {
                        return Err(StaticEvalError::new("array spreads are unsupported"));
                    }
                    let Some(value) = self.eval_expr(&element.expr, env, depth + 1)? else {
                        return Ok(None);
                    };
                    values.push(value);
                }
                Ok(Some(Value::Array(values)))
            }
            Expr::Object(object) => {
                let mut values = BTreeMap::new();
                for property in &object.props {
                    let PropOrSpread::Prop(property) = property else {
                        return Err(StaticEvalError::new("object spreads are unsupported"));
                    };
                    match property.as_ref() {
                        Prop::KeyValue(kv) => {
                            let key = static_prop_name(&kv.key)?;
                            let Some(value) = self.eval_expr(&kv.value, env, depth + 1)? else {
                                return Ok(None);
                            };
                            values.insert(key, value);
                        }
                        Prop::Shorthand(id) => {
                            let Some(value) =
                                self.eval_expr(&Expr::Ident(id.clone()), env, depth + 1)?
                            else {
                                return Ok(None);
                            };
                            values.insert(id.sym.to_string(), value);
                        }
                        _ => {
                            return Err(StaticEvalError::new(
                                "object methods and accessors are unsupported",
                            ));
                        }
                    }
                }
                Ok(Some(Value::Object(values)))
            }
            Expr::Member(member) => {
                let Some(object) = self.eval_expr(&member.obj, env, depth + 1)? else {
                    return Ok(None);
                };
                let key = self.member_key(&member.prop, env, depth + 1)?;
                Ok(Some(read_property(object, &key)?))
            }
            Expr::OptChain(chain) => match chain.base.as_ref() {
                OptChainBase::Member(member) => {
                    let Some(object) = self.eval_expr(&member.obj, env, depth + 1)? else {
                        return Ok(None);
                    };
                    if matches!(object, Value::Null | Value::Undefined) {
                        return Ok(Some(Value::Undefined));
                    }
                    let key = self.member_key(&member.prop, env, depth + 1)?;
                    Ok(Some(read_property(object, &key)?))
                }
                OptChainBase::Call(_) => Ok(None),
            },
            Expr::Unary(unary) => {
                let Some(value) = self.eval_expr(&unary.arg, env, depth + 1)? else {
                    return Ok(None);
                };
                match unary.op {
                    UnaryOp::Bang => Ok(Some(Value::Bool(!truthy(&value)))),
                    UnaryOp::Minus => match value {
                        Value::Number(value) => Ok(Some(Value::Number(-value))),
                        _ => Err(StaticEvalError::new("unary minus expects a number")),
                    },
                    _ => Err(StaticEvalError::new(format!(
                        "unsupported unary operator {:?}",
                        unary.op
                    ))),
                }
            }
            Expr::Bin(binary) => self.eval_binary(binary, env, depth + 1),
            Expr::Cond(cond) => {
                let Some(test) = self.eval_expr(&cond.test, env, depth + 1)? else {
                    return Ok(None);
                };
                if truthy(&test) {
                    self.eval_expr(&cond.cons, env, depth + 1)
                } else {
                    self.eval_expr(&cond.alt, env, depth + 1)
                }
            }
            _ => Ok(None),
        }
    }

    fn member_key(
        &mut self,
        property: &MemberProp,
        env: &Bindings,
        depth: usize,
    ) -> Result<String, StaticEvalError> {
        match property {
            MemberProp::Ident(id) => Ok(id.sym.to_string()),
            MemberProp::Computed(computed) => match self.eval_expr(&computed.expr, env, depth)? {
                Some(Value::String(value)) => Ok(value),
                Some(Value::Number(value)) if value.fract() == 0.0 => {
                    Ok((value as i64).to_string())
                }
                Some(_) => Err(StaticEvalError::new(
                    "computed property must be a string or integer",
                )),
                None => Err(StaticEvalError::new("dynamic computed property")),
            },
            MemberProp::PrivateName(_) => {
                Err(StaticEvalError::new("private properties are unsupported"))
            }
        }
    }

    fn eval_binary(
        &mut self,
        binary: &BinExpr,
        env: &Bindings,
        depth: usize,
    ) -> Result<Option<Value>, StaticEvalError> {
        let Some(left) = self.eval_expr(&binary.left, env, depth + 1)? else {
            return Ok(None);
        };
        match binary.op {
            BinaryOp::LogicalAnd if !truthy(&left) => return Ok(Some(left)),
            BinaryOp::LogicalOr if truthy(&left) => return Ok(Some(left)),
            BinaryOp::NullishCoalescing if !matches!(left, Value::Null | Value::Undefined) => {
                return Ok(Some(left));
            }
            _ => {}
        }
        let Some(right) = self.eval_expr(&binary.right, env, depth + 1)? else {
            return Ok(None);
        };
        let value = match binary.op {
            BinaryOp::LogicalAnd | BinaryOp::LogicalOr | BinaryOp::NullishCoalescing => right,
            BinaryOp::Add => add_values(left, right)?,
            BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => {
                let (Value::Number(left), Value::Number(right)) = (left, right) else {
                    return Err(StaticEvalError::new("arithmetic expects numbers"));
                };
                let value = match binary.op {
                    BinaryOp::Sub => left - right,
                    BinaryOp::Mul => left * right,
                    BinaryOp::Div => left / right,
                    BinaryOp::Mod => left % right,
                    _ => unreachable!(),
                };
                if !value.is_finite() {
                    return Err(StaticEvalError::new("non-finite arithmetic result"));
                }
                Value::Number(value)
            }
            BinaryOp::EqEq | BinaryOp::EqEqEq => Value::Bool(equal_values(&left, &right)),
            BinaryOp::NotEq | BinaryOp::NotEqEq => Value::Bool(!equal_values(&left, &right)),
            BinaryOp::Lt | BinaryOp::LtEq | BinaryOp::Gt | BinaryOp::GtEq => {
                Value::Bool(compare_values(&left, &right, binary.op)?)
            }
            _ => {
                return Err(StaticEvalError::new(format!(
                    "unsupported binary operator {:?}",
                    binary.op
                )));
            }
        };
        Ok(Some(value))
    }

    fn expand_block(
        &mut self,
        block: &mut BlockStmt,
        env: &mut Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        self.check_depth(depth)?;
        let mut kept = Vec::with_capacity(block.stmts.len());
        for mut statement in std::mem::take(&mut block.stmts) {
            if let Stmt::Decl(Decl::Var(var)) = &mut statement
                && var.kind == VarDeclKind::Const
            {
                let mut all_static = true;
                for declaration in &mut var.decls {
                    let Some(initializer) = &mut declaration.init else {
                        return Err(StaticEvalError::new("const without initializer"));
                    };
                    self.expand_expr(initializer, env, depth)?;
                    if let Pat::Ident(binding) = &declaration.name
                        && self.eval_expr(initializer, env, depth + 1)?.is_some()
                    {
                        self.add_binding()?;
                        env.insert(binding.id.sym.to_string(), initializer.clone());
                    } else {
                        all_static = false;
                    }
                }
                if all_static {
                    self.changed = true;
                    continue;
                }
            }
            self.expand_stmt(&mut statement, env, depth)?;
            kept.push(statement);
        }
        block.stmts = kept;
        Ok(())
    }

    fn expand_stmt(
        &mut self,
        statement: &mut Stmt,
        env: &mut Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        match statement {
            Stmt::Return(ret) => {
                if let Some(argument) = &mut ret.arg {
                    self.expand_expr(argument, env, depth)?;
                }
            }
            Stmt::Expr(expression) => self.expand_expr(&mut expression.expr, env, depth)?,
            Stmt::If(if_statement) => {
                self.expand_expr(&mut if_statement.test, env, depth)?;
                self.expand_stmt(&mut if_statement.cons, &mut env.clone(), depth)?;
                if let Some(alternate) = &mut if_statement.alt {
                    self.expand_stmt(alternate, &mut env.clone(), depth)?;
                }
            }
            Stmt::Block(block) => self.expand_block(block, &mut env.clone(), depth)?,
            _ => {}
        }
        Ok(())
    }

    fn expand_expr(
        &mut self,
        expression: &mut Expr,
        env: &Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        self.check_depth(depth)?;

        if let Expr::Cond(conditional) = expression
            && let Some(test) = self.eval_expr(&conditional.test, env, depth + 1)?
        {
            *expression = if truthy(&test) {
                (*conditional.cons).clone()
            } else {
                (*conditional.alt).clone()
            };
            self.changed = true;
            self.expand_expr(expression, env, depth + 1)?;
            return Ok(());
        }
        if let Expr::Bin(binary) = expression
            && matches!(
                binary.op,
                BinaryOp::LogicalAnd | BinaryOp::LogicalOr | BinaryOp::NullishCoalescing
            )
            && let Some(left) = self.eval_expr(&binary.left, env, depth + 1)?
        {
            let choose_left = match binary.op {
                BinaryOp::LogicalAnd => !truthy(&left),
                BinaryOp::LogicalOr => truthy(&left),
                BinaryOp::NullishCoalescing => !matches!(left, Value::Null | Value::Undefined),
                _ => unreachable!(),
            };
            *expression = if choose_left {
                value_to_expr(&left)
            } else {
                (*binary.right).clone()
            };
            self.changed = true;
            self.expand_expr(expression, env, depth + 1)?;
            return Ok(());
        }

        if matches!(expression, Expr::Call(_))
            && let Some(replacement) = self.expand_map_expr(expression, env, depth)?
        {
            *expression = replacement;
            self.changed = true;
            return Ok(());
        }

        if let Expr::JSXElement(element) = expression {
            if let Some(replacement) = self.expand_helper_element(element, env, depth)? {
                *expression = replacement;
                self.changed = true;
                self.expand_expr(expression, env, depth + 1)?;
                return Ok(());
            }
            self.expand_jsx_element(element, env, depth)?;
            return Ok(());
        }
        if let Expr::JSXFragment(fragment) = expression {
            self.expand_jsx_children(&mut fragment.children, env, depth)?;
            return Ok(());
        }

        if let Some(value) = self.eval_expr(expression, env, depth + 1)? {
            let replacement = value_to_expr(&value);
            if !same_simple_expr(expression, &replacement) {
                *expression = replacement;
                self.changed = true;
            }
            return Ok(());
        }

        match expression {
            Expr::Paren(paren) => self.expand_expr(&mut paren.expr, env, depth)?,
            Expr::Member(member) => {
                self.expand_expr(&mut member.obj, env, depth)?;
                if let MemberProp::Computed(computed) = &mut member.prop {
                    self.expand_expr(&mut computed.expr, env, depth)?;
                }
            }
            Expr::OptChain(chain) => match chain.base.as_mut() {
                OptChainBase::Member(member) => {
                    self.expand_expr(&mut member.obj, env, depth)?;
                    if let MemberProp::Computed(computed) = &mut member.prop {
                        self.expand_expr(&mut computed.expr, env, depth)?;
                    }
                }
                OptChainBase::Call(call) => {
                    self.expand_expr(&mut call.callee, env, depth)?;
                    for argument in &mut call.args {
                        self.expand_expr(&mut argument.expr, env, depth)?;
                    }
                }
            },
            Expr::Call(call) => {
                if let Callee::Expr(callee) = &mut call.callee {
                    self.expand_expr(callee, env, depth)?;
                }
                for argument in &mut call.args {
                    self.expand_expr(&mut argument.expr, env, depth)?;
                }
            }
            Expr::Bin(binary) => {
                self.expand_expr(&mut binary.left, env, depth)?;
                self.expand_expr(&mut binary.right, env, depth)?;
            }
            Expr::Cond(conditional) => {
                self.expand_expr(&mut conditional.test, env, depth)?;
                self.expand_expr(&mut conditional.cons, env, depth)?;
                self.expand_expr(&mut conditional.alt, env, depth)?;
            }
            Expr::Unary(unary) => self.expand_expr(&mut unary.arg, env, depth)?,
            Expr::Array(array) => {
                for element in array.elems.iter_mut().flatten() {
                    self.expand_expr(&mut element.expr, env, depth)?;
                }
            }
            Expr::Object(object) => {
                for property in &mut object.props {
                    if let PropOrSpread::Prop(property) = property
                        && let Prop::KeyValue(kv) = property.as_mut()
                    {
                        self.expand_expr(&mut kv.value, env, depth)?;
                    }
                }
            }
            Expr::Tpl(template) => {
                for expression in &mut template.exprs {
                    self.expand_expr(expression, env, depth)?;
                }
            }
            _ => {}
        }

        if let Some(value) = self.eval_expr(expression, env, depth + 1)? {
            *expression = value_to_expr(&value);
            self.changed = true;
        }
        Ok(())
    }

    fn expand_map_expr(
        &mut self,
        expression: &Expr,
        env: &Bindings,
        depth: usize,
    ) -> Result<Option<Expr>, StaticEvalError> {
        let Expr::Call(call) = expression else {
            return Ok(None);
        };
        let Callee::Expr(callee) = &call.callee else {
            return Ok(None);
        };
        let Expr::Member(member) = strip_paren(callee) else {
            return Ok(None);
        };
        if !matches!(&member.prop, MemberProp::Ident(id) if id.sym.as_ref() == "map") {
            return Ok(None);
        }
        let Some(Value::Array(items)) = self.eval_expr(&member.obj, env, depth + 1)? else {
            return Ok(None);
        };
        if call.args.len() != 1 || call.args[0].spread.is_some() {
            return Err(StaticEvalError::new("static map expects one callback"));
        }
        let Expr::Arrow(arrow) = strip_paren(&call.args[0].expr) else {
            return Err(StaticEvalError::new(
                "static map callback must be an arrow function",
            ));
        };
        if arrow.params.is_empty() || arrow.params.len() > 2 {
            return Err(StaticEvalError::new(
                "static map callback expects item and optional index",
            ));
        }
        if arrow.params.len() == 2 && !matches!(arrow.params[1], Pat::Ident(_)) {
            return Err(StaticEvalError::new(
                "static map index must be an identifier",
            ));
        }

        let mut children = Vec::new();
        for (index, item) in items.iter().enumerate() {
            self.add_expansion()?;
            let mut inner = env.clone();
            self.bind_pattern(&arrow.params[0], item, &mut inner, depth + 1)?;
            if let Some(Pat::Ident(binding)) = arrow.params.get(1) {
                self.add_binding()?;
                inner.insert(
                    binding.id.sym.to_string(),
                    Box::new(value_to_expr(&Value::Number(index as f64))),
                );
            }
            let mut result = match arrow.body.as_ref() {
                BlockStmtOrExpr::Expr(expression) => (**expression).clone(),
                BlockStmtOrExpr::BlockStmt(block) => {
                    let mut block = block.clone();
                    self.expand_block(&mut block, &mut inner, depth + 1)?;
                    if block.stmts.len() != 1 {
                        return Err(StaticEvalError::new(
                            "static map block must contain leading consts and one return",
                        ));
                    }
                    let Stmt::Return(ReturnStmt {
                        arg: Some(argument),
                        ..
                    }) = &block.stmts[0]
                    else {
                        return Err(StaticEvalError::new("static map block must return JSX"));
                    };
                    (**argument).clone()
                }
            };
            self.expand_expr(&mut result, &inner, depth + 1)?;
            append_expr_children(result, &mut children);
        }
        Ok(Some(Expr::JSXFragment(JSXFragment {
            span: call.span,
            opening: JSXOpeningFragment { span: call.span },
            children,
            closing: JSXClosingFragment { span: call.span },
        })))
    }

    fn bind_pattern(
        &mut self,
        pattern: &Pat,
        value: &Value,
        env: &mut Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        self.check_depth(depth)?;
        match pattern {
            Pat::Ident(binding) => {
                self.add_binding()?;
                env.insert(binding.id.sym.to_string(), Box::new(value_to_expr(value)));
            }
            Pat::Array(array) => {
                let Value::Array(values) = value else {
                    return Err(StaticEvalError::new("array pattern expects an array"));
                };
                for (index, pattern) in array.elems.iter().enumerate() {
                    if let Some(pattern) = pattern {
                        self.bind_pattern(
                            pattern,
                            values.get(index).unwrap_or(&Value::Undefined),
                            env,
                            depth + 1,
                        )?;
                    }
                }
            }
            Pat::Object(object) => {
                let Value::Object(values) = value else {
                    return Err(StaticEvalError::new("object pattern expects an object"));
                };
                for property in &object.props {
                    match property {
                        ObjectPatProp::Assign(assign) => {
                            let value = if let Some(value) = values.get(assign.key.sym.as_ref()) {
                                value.clone()
                            } else if let Some(default) = &assign.value {
                                self.eval_expr(default, env, depth + 1)?.ok_or_else(|| {
                                    StaticEvalError::new("dynamic destructuring default")
                                })?
                            } else {
                                Value::Undefined
                            };
                            self.add_binding()?;
                            env.insert(assign.key.sym.to_string(), Box::new(value_to_expr(&value)));
                        }
                        ObjectPatProp::KeyValue(kv) => {
                            let key = static_prop_name(&kv.key)?;
                            self.bind_pattern(
                                &kv.value,
                                values.get(&key).unwrap_or(&Value::Undefined),
                                env,
                                depth + 1,
                            )?;
                        }
                        ObjectPatProp::Rest(_) => {
                            return Err(StaticEvalError::new("rest patterns are unsupported"));
                        }
                    }
                }
            }
            Pat::Assign(assign) => {
                if matches!(value, Value::Undefined) {
                    let default = self
                        .eval_expr(&assign.right, env, depth + 1)?
                        .ok_or_else(|| StaticEvalError::new("dynamic pattern default"))?;
                    self.bind_pattern(&assign.left, &default, env, depth + 1)?;
                } else {
                    self.bind_pattern(&assign.left, value, env, depth + 1)?;
                }
            }
            _ => return Err(StaticEvalError::new("unsupported callback pattern")),
        }
        Ok(())
    }

    fn expand_jsx_element(
        &mut self,
        element: &mut JSXElement,
        env: &Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        if let JSXElementName::Ident(name) = &element.opening.name
            && let Some(bound) = env.get(name.sym.as_ref())
            && let Some(Value::Symbol(symbol)) = self.eval_expr(bound, env, depth + 1)?
        {
            let replacement = Ident::new_no_ctxt(symbol.into(), name.span);
            element.opening.name = JSXElementName::Ident(replacement.clone());
            if let Some(closing) = &mut element.closing {
                closing.name = JSXElementName::Ident(replacement);
            }
            self.changed = true;
        }
        for attribute in &mut element.opening.attrs {
            match attribute {
                JSXAttrOrSpread::JSXAttr(attribute) => {
                    if let Some(JSXAttrValue::JSXExprContainer(container)) = &mut attribute.value
                        && let JSXExpr::Expr(expression) = &mut container.expr
                    {
                        self.expand_expr(expression, env, depth)?;
                    }
                }
                JSXAttrOrSpread::SpreadElement(spread) => {
                    self.expand_expr(&mut spread.expr, env, depth)?;
                }
            }
        }
        self.expand_jsx_children(&mut element.children, env, depth)
    }

    fn expand_jsx_children(
        &mut self,
        children: &mut Vec<JSXElementChild>,
        env: &Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        let mut expanded = Vec::new();
        for child in std::mem::take(children) {
            match child {
                JSXElementChild::JSXElement(element) => {
                    let mut expression = Expr::JSXElement(element);
                    self.expand_expr(&mut expression, env, depth)?;
                    append_expr_children(expression, &mut expanded);
                }
                JSXElementChild::JSXFragment(fragment) => {
                    let mut expression = Expr::JSXFragment(fragment);
                    self.expand_expr(&mut expression, env, depth)?;
                    append_expr_children(expression, &mut expanded);
                }
                JSXElementChild::JSXExprContainer(mut container) => {
                    if let JSXExpr::Expr(expression) = &mut container.expr {
                        self.expand_expr(expression, env, depth)?;
                        if matches!(
                            strip_paren(expression),
                            Expr::JSXFragment(_)
                                | Expr::JSXElement(_)
                                | Expr::Lit(Lit::Null(_))
                                | Expr::Lit(Lit::Bool(_))
                        ) || matches!(
                            strip_paren(expression),
                            Expr::Ident(id) if id.sym.as_ref() == "undefined"
                        ) {
                            append_expr_children((**expression).clone(), &mut expanded);
                            self.changed = true;
                            continue;
                        }
                    }
                    expanded.push(JSXElementChild::JSXExprContainer(container));
                }
                JSXElementChild::JSXSpreadChild(mut spread) => {
                    self.expand_expr(&mut spread.expr, env, depth)?;
                    expanded.push(JSXElementChild::JSXSpreadChild(spread));
                }
                other => expanded.push(other),
            }
        }
        *children = expanded;
        Ok(())
    }

    fn expand_helper_element(
        &mut self,
        element: &JSXElement,
        env: &Bindings,
        depth: usize,
    ) -> Result<Option<Expr>, StaticEvalError> {
        let JSXElementName::Ident(name) = &element.opening.name else {
            return Ok(None);
        };
        let helper_name = name.sym.as_ref();
        let Some(helper) = self.helpers.get(helper_name).copied() else {
            return Ok(None);
        };
        if helper_name == self.root_name {
            return Ok(None);
        }
        if self.helper_stack.iter().any(|entry| entry == helper_name) {
            let mut path = self.helper_stack.join(" -> ");
            if !path.is_empty() {
                path.push_str(" -> ");
            }
            path.push_str(helper_name);
            return Err(StaticEvalError::new(format!("helper cycle: {path}")));
        }
        let body = helper
            .function
            .body
            .as_ref()
            .ok_or_else(|| StaticEvalError::new(format!("helper {helper_name} has no body")))?;
        if let Inlinability::Fallback(reason) = analyze(body) {
            return Err(StaticEvalError::new(format!(
                "helper {helper_name}: {reason}"
            )));
        }

        self.add_expansion()?;
        self.helper_stack.push(helper_name.to_string());
        let result = self.expand_helper_element_inner(element, helper, env, depth);
        self.helper_stack.pop();
        result.map(Some)
    }

    fn expand_helper_element_inner(
        &mut self,
        element: &JSXElement,
        helper: &FnDecl,
        env: &Bindings,
        depth: usize,
    ) -> Result<Expr, StaticEvalError> {
        let mut attributes: HashMap<String, Box<Expr>> = HashMap::new();
        for attribute in &element.opening.attrs {
            let JSXAttrOrSpread::JSXAttr(attribute) = attribute else {
                return Err(StaticEvalError::new("helper spread props are unsupported"));
            };
            let JSXAttrName::Ident(name) = &attribute.name else {
                return Err(StaticEvalError::new(
                    "helper namespaced props are unsupported",
                ));
            };
            let key = name.sym.to_string();
            if key == "key" || key == "native" {
                continue;
            }
            let mut value = match &attribute.value {
                None => value_to_expr(&Value::Bool(true)),
                Some(JSXAttrValue::Str(value)) => {
                    value_to_expr(&Value::String(value.value.to_string_lossy().into_owned()))
                }
                Some(JSXAttrValue::JSXExprContainer(container)) => match &container.expr {
                    JSXExpr::Expr(expression) => (**expression).clone(),
                    JSXExpr::JSXEmptyExpr(_) => {
                        return Err(StaticEvalError::new("empty helper prop expression"));
                    }
                },
                _ => return Err(StaticEvalError::new("JSX helper props are unsupported")),
            };
            self.expand_expr(&mut value, env, depth + 1)?;
            attributes.insert(key, Box::new(value));
        }
        if !element.children.is_empty() {
            attributes.insert(
                "children".to_string(),
                Box::new(Expr::JSXFragment(JSXFragment {
                    span: element.span,
                    opening: JSXOpeningFragment { span: element.span },
                    children: element.children.clone(),
                    closing: JSXClosingFragment { span: element.span },
                })),
            );
        }

        let mut helper_env = env.clone();
        match helper.function.params.as_slice() {
            [] => {}
            [parameter] => {
                self.bind_helper_pattern(&parameter.pat, &attributes, &mut helper_env, depth + 1)?
            }
            _ => {
                return Err(StaticEvalError::new(
                    "helper must take zero or one props parameter",
                ));
            }
        }

        let mut body = helper
            .function
            .body
            .clone()
            .ok_or_else(|| StaticEvalError::new("helper has no body"))?;
        self.expand_block(&mut body, &mut helper_env, depth + 1)?;
        if body.stmts.len() != 1 {
            return Err(StaticEvalError::new("helper has unsupported return shape"));
        }
        match &body.stmts[0] {
            Stmt::Return(ReturnStmt {
                arg: Some(argument),
                ..
            }) => Ok((**argument).clone()),
            _ => Err(StaticEvalError::new("helper must return JSX")),
        }
    }

    fn bind_helper_pattern(
        &mut self,
        pattern: &Pat,
        attributes: &HashMap<String, Box<Expr>>,
        env: &mut Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        match pattern {
            Pat::Ident(binding) => {
                self.add_binding()?;
                env.insert(
                    binding.id.sym.to_string(),
                    Box::new(object_expr(attributes)),
                );
            }
            Pat::Object(object) => {
                for property in &object.props {
                    match property {
                        ObjectPatProp::Assign(assign) => {
                            let mut value = attributes
                                .get(assign.key.sym.as_ref())
                                .cloned()
                                .unwrap_or_else(|| Box::new(value_to_expr(&Value::Undefined)));
                            self.expand_expr(&mut value, env, depth + 1)?;
                            if matches!(
                                self.eval_expr(&value, env, depth + 1)?,
                                Some(Value::Undefined)
                            ) && let Some(default) = &assign.value
                            {
                                let evaluated =
                                    self.eval_expr(default, env, depth + 1)?.ok_or_else(|| {
                                        StaticEvalError::new(format!(
                                            "dynamic helper default `{}`",
                                            assign.key.sym
                                        ))
                                    })?;
                                value = Box::new(value_to_expr(&evaluated));
                            }
                            self.add_binding()?;
                            env.insert(assign.key.sym.to_string(), value);
                        }
                        ObjectPatProp::KeyValue(kv) => {
                            let key = static_prop_name(&kv.key)?;
                            let value = attributes
                                .get(&key)
                                .cloned()
                                .unwrap_or_else(|| Box::new(value_to_expr(&Value::Undefined)));
                            self.bind_helper_value_pattern(&kv.value, value, env, depth + 1)?;
                        }
                        ObjectPatProp::Rest(_) => {
                            return Err(StaticEvalError::new("helper rest props are unsupported"));
                        }
                    }
                }
            }
            _ => return Err(StaticEvalError::new("unsupported helper props pattern")),
        }
        Ok(())
    }

    fn bind_helper_value_pattern(
        &mut self,
        pattern: &Pat,
        value: Box<Expr>,
        env: &mut Bindings,
        depth: usize,
    ) -> Result<(), StaticEvalError> {
        match pattern {
            Pat::Ident(binding) => {
                self.add_binding()?;
                env.insert(binding.id.sym.to_string(), value);
            }
            Pat::Assign(assign) => {
                let actual = if matches!(
                    self.eval_expr(&value, env, depth + 1)?,
                    Some(Value::Undefined)
                ) {
                    let evaluated =
                        self.eval_expr(&assign.right, env, depth + 1)?
                            .ok_or_else(|| {
                                let name = match assign.left.as_ref() {
                                    Pat::Ident(binding) => binding.id.sym.as_ref(),
                                    _ => "nested",
                                };
                                StaticEvalError::new(format!("dynamic helper default `{name}`"))
                            })?;
                    Box::new(value_to_expr(&evaluated))
                } else {
                    value
                };
                self.bind_helper_value_pattern(&assign.left, actual, env, depth + 1)?;
            }
            _ => return Err(StaticEvalError::new("nested helper pattern is unsupported")),
        }
        Ok(())
    }
}

fn strip_paren(mut expression: &Expr) -> &Expr {
    while let Expr::Paren(paren) = expression {
        expression = &paren.expr;
    }
    expression
}

fn static_prop_name(name: &PropName) -> Result<String, StaticEvalError> {
    match name {
        PropName::Ident(id) => Ok(id.sym.to_string()),
        PropName::Str(value) => Ok(value.value.to_string_lossy().into_owned()),
        PropName::Num(value) if value.value.fract() == 0.0 => Ok((value.value as i64).to_string()),
        _ => Err(StaticEvalError::new("computed object keys are unsupported")),
    }
}

fn read_property(value: Value, key: &str) -> Result<Value, StaticEvalError> {
    match value {
        Value::Object(values) => Ok(values.get(key).cloned().unwrap_or(Value::Undefined)),
        Value::Array(values) if key == "length" => Ok(Value::Number(values.len() as f64)),
        Value::Array(values) => key
            .parse::<usize>()
            .ok()
            .and_then(|index| values.get(index).cloned())
            .ok_or_else(|| StaticEvalError::new(format!("array property {key} is unsupported"))),
        Value::String(value) if key == "length" => Ok(Value::Number(value.chars().count() as f64)),
        Value::Null | Value::Undefined => {
            Err(StaticEvalError::new("property access on null or undefined"))
        }
        _ => Err(StaticEvalError::new(format!(
            "property {key} is unsupported"
        ))),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Undefined | Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => *value != 0.0 && !value.is_nan(),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) | Value::Symbol(_) => true,
    }
}

fn add_values(left: Value, right: Value) -> Result<Value, StaticEvalError> {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => Ok(Value::Number(left + right)),
        (Value::String(left), right) => {
            let right = value_string(&right);
            Ok(Value::String(left + right.as_str()))
        }
        (left, Value::String(right)) => {
            let mut left = value_string(&left);
            left.push_str(&right);
            Ok(Value::String(left))
        }
        _ => Err(StaticEvalError::new(
            "addition expects two numbers or a string operand",
        )),
    }
}

fn value_string(value: &Value) -> String {
    match value {
        Value::Undefined => "undefined".to_string(),
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => format_number(*value),
        Value::String(value) | Value::Symbol(value) => value.clone(),
        Value::Array(_) => "[object Array]".to_string(),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn equal_values(left: &Value, right: &Value) -> bool {
    left == right
}

fn compare_values(
    left: &Value,
    right: &Value,
    operator: BinaryOp,
) -> Result<bool, StaticEvalError> {
    let ordering = match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.partial_cmp(right),
        (Value::String(left), Value::String(right)) => Some(left.cmp(right)),
        _ => {
            return Err(StaticEvalError::new(
                "comparison operands must share a scalar type",
            ));
        }
    };
    let Some(ordering) = ordering else {
        return Err(StaticEvalError::new("unordered comparison"));
    };
    Ok(match operator {
        BinaryOp::Lt => ordering.is_lt(),
        BinaryOp::LtEq => ordering.is_le(),
        BinaryOp::Gt => ordering.is_gt(),
        BinaryOp::GtEq => ordering.is_ge(),
        _ => unreachable!(),
    })
}

fn value_to_expr(value: &Value) -> Expr {
    match value {
        Value::Undefined => Expr::Ident(Ident::new_no_ctxt("undefined".into(), DUMMY_SP)),
        Value::Null => Expr::Lit(Lit::Null(Null { span: DUMMY_SP })),
        Value::Bool(value) => Expr::Lit(Lit::Bool(Bool {
            span: DUMMY_SP,
            value: *value,
        })),
        Value::Number(value) => Expr::Lit(Lit::Num(Number {
            span: DUMMY_SP,
            value: *value,
            raw: None,
        })),
        Value::String(value) => Expr::Lit(Lit::Str(Str {
            span: DUMMY_SP,
            value: value.clone().into(),
            raw: None,
        })),
        Value::Symbol(value) => Expr::Ident(Ident::new_no_ctxt(value.clone().into(), DUMMY_SP)),
        Value::Array(values) => Expr::Array(ArrayLit {
            span: DUMMY_SP,
            elems: values
                .iter()
                .map(|value| {
                    Some(ExprOrSpread {
                        spread: None,
                        expr: Box::new(value_to_expr(value)),
                    })
                })
                .collect(),
        }),
        Value::Object(values) => Expr::Object(ObjectLit {
            span: DUMMY_SP,
            props: values
                .iter()
                .map(|(key, value)| {
                    PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                        key: PropName::Str(Str {
                            span: DUMMY_SP,
                            value: key.clone().into(),
                            raw: None,
                        }),
                        value: Box::new(value_to_expr(value)),
                    })))
                })
                .collect(),
        }),
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    use crate::parser::parse;

    fn expand_error(source: &str) -> String {
        let parsed = parse(source, "<static-eval-test>").unwrap();
        let (name, function) = parsed
            .module
            .body
            .iter()
            .find_map(|item| match item {
                ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(export)) => {
                    match &export.decl {
                        DefaultDecl::Fn(function) => Some((
                            function
                                .ident
                                .as_ref()
                                .map(|ident| ident.sym.as_ref())
                                .unwrap_or("default"),
                            &function.function,
                        )),
                        _ => None,
                    }
                }
                _ => None,
            })
            .expect("named default function");
        expand_inline_body(&parsed.module, name, function)
            .unwrap_err()
            .message
    }

    #[test]
    fn reports_expansion_budget_at_the_static_eval_seam() {
        let helpers = "<Helper/>".repeat(MAX_EXPANSIONS + 1);
        let source = format!(
            "function Helper() {{ return <i/>; }} export default function Root() {{ return <>{helpers}</>; }}"
        );
        assert_eq!(
            expand_error(&source),
            format!("expansion budget exceeded (max {MAX_EXPANSIONS})")
        );
    }

    #[test]
    fn reports_binding_budget_at_the_static_eval_seam() {
        let declarations = (0..=MAX_BINDINGS)
            .map(|index| format!("const V{index}={index};"))
            .collect::<String>();
        let source = format!("{declarations} export default function Root() {{ return <div/>; }}");
        assert_eq!(
            expand_error(&source),
            format!("binding budget exceeded (max {MAX_BINDINGS})")
        );
    }

    #[test]
    fn reports_depth_budget_at_the_static_eval_seam() {
        let nested = format!(
            "{}0{}",
            "[".repeat(MAX_DEPTH + 2),
            "]".repeat(MAX_DEPTH + 2)
        );
        let source = format!(
            "const ITEMS={nested}; export default function Root() {{ return <>{{ITEMS.map(item => <i>{{item}}</i>)}}</>; }}"
        );
        assert_eq!(
            expand_error(&source),
            format!("recursion depth exceeded (max {MAX_DEPTH})")
        );
    }

    #[test]
    fn reports_helper_hook_and_cycle_at_the_static_eval_seam() {
        let hook = r#"
function Helper() { const [value] = useState(0); return <i>{value}</i>; }
export default function Root() { return <Helper/>; }
"#;
        let hook_error = expand_error(hook);
        assert!(
            hook_error.contains("helper Helper") && hook_error.contains("useState"),
            "unexpected hook reason: {hook_error}"
        );

        let cycle = r#"
function A() { return <B/>; }
function B() { return <A/>; }
export default function Root() { return <A/>; }
"#;
        assert_eq!(expand_error(cycle), "helper cycle: A -> B -> A");
    }
}

fn object_expr(values: &HashMap<String, Box<Expr>>) -> Expr {
    Expr::Object(ObjectLit {
        span: DUMMY_SP,
        props: values
            .iter()
            .map(|(key, value)| {
                PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Str(Str {
                        span: DUMMY_SP,
                        value: key.clone().into(),
                        raw: None,
                    }),
                    value: value.clone(),
                })))
            })
            .collect(),
    })
}

fn append_expr_children(expression: Expr, children: &mut Vec<JSXElementChild>) {
    match expression {
        Expr::Paren(paren) => append_expr_children(*paren.expr, children),
        Expr::JSXElement(element) => children.push(JSXElementChild::JSXElement(element)),
        Expr::JSXFragment(fragment) => children.extend(fragment.children),
        Expr::Lit(Lit::Null(_)) | Expr::Lit(Lit::Bool(_)) => {}
        Expr::Ident(id) if id.sym.as_ref() == "undefined" => {}
        other => children.push(JSXElementChild::JSXExprContainer(JSXExprContainer {
            span: other.span(),
            expr: JSXExpr::Expr(Box::new(other)),
        })),
    }
}

fn same_simple_expr(left: &Expr, right: &Expr) -> bool {
    match (strip_paren(left), strip_paren(right)) {
        (Expr::Lit(Lit::Str(left)), Expr::Lit(Lit::Str(right))) => left.value == right.value,
        (Expr::Lit(Lit::Bool(left)), Expr::Lit(Lit::Bool(right))) => left.value == right.value,
        (Expr::Lit(Lit::Null(_)), Expr::Lit(Lit::Null(_))) => true,
        (Expr::Lit(Lit::Num(left)), Expr::Lit(Lit::Num(right))) => left.value == right.value,
        (Expr::Ident(left), Expr::Ident(right)) => left.sym == right.sym,
        _ => false,
    }
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser;

    fn expand(source: &str) -> Result<BlockStmt, StaticEvalError> {
        let parsed = parser::parse(source, "test.tsx").unwrap();
        for item in &parsed.module.body {
            if let ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(export)) = item
                && let DefaultDecl::Fn(function) = &export.decl
            {
                return expand_inline_body(&parsed.module, "Root", &function.function)
                    .map(Cow::into_owned);
            }
        }
        panic!("missing default function")
    }

    #[test]
    fn expands_static_map_and_private_helper() {
        let body = expand(
            r#"
            const ITEMS = [{ label: 'a' }, { label: 'b' }]
            function Row({ label }) { return <li>{label}</li> }
            export default function Root() {
              return <ul>{ITEMS.map((item) => <Row label={item.label} />)}</ul>
            }
            "#,
        )
        .unwrap();
        let text = format!("{body:?}");
        assert!(text.contains("a"));
        assert!(text.contains("b"));
        assert!(!text.contains("ITEMS"));
    }

    #[test]
    fn runtime_map_is_left_for_the_existing_lowerer() {
        let body = expand(
            r#"export default function Root({ items }) {
              return <ul>{items.map((item) => <li>{item.label}</li>)}</ul>
            }"#,
        )
        .unwrap();
        assert!(format!("{body:?}").contains("map"));
    }

    #[test]
    fn constant_cycle_fails_closed() {
        let error = expand(
            r#"const A = B; const B = A;
               export default function Root(){ return <p>{A}</p> }"#,
        )
        .unwrap_err();
        assert!(error.message.contains("constant cycle"));
    }

    #[test]
    fn dynamic_helper_defaults_are_checked_only_when_selected() {
        let selected = expand(
            r#"
            function Row({ label = makeLabel() }) { return <li>{label}</li> }
            export default function Root() { return <Row/> }
            "#,
        )
        .unwrap_err();
        assert_eq!(selected.message, "dynamic helper default `label`");

        let unused = expand(
            r#"
            function Direct({ label = makeLabel() }) { return <li>{label}</li> }
            function Aliased({ label: text = makeLabel() }) { return <i>{text}</i> }
            export default function Root() {
              return <><Direct label="direct"/><Aliased label="aliased"/></>
            }
            "#,
        )
        .unwrap();
        let text = format!("{unused:?}");
        assert!(text.contains("direct"), "{text}");
        assert!(text.contains("aliased"), "{text}");
        assert!(!text.contains("makeLabel"), "{text}");
    }

    #[test]
    fn fixture_reaches_inline_lowerer() {
        let source = include_str!("../../../tests/fixtures/app/NativeStaticEval.tsx");
        let sources = HashMap::from([("NativeStaticEval".to_string(), source.to_string())]);
        let icon = r#"{"cls":"lucide","node":[]}"#.to_string();
        let icons = HashMap::from([
            ("Check".to_string(), icon.clone()),
            ("ShieldCheck".to_string(), icon),
        ]);
        let compiled = crate::compile_full(
            "export default function Route(){ return <NativeStaticEval native /> }",
            "Route.tsx",
            sources,
            icons,
            HashMap::new(),
        )
        .unwrap();
        assert!(
            compiled.warnings.is_empty(),
            "fixture warnings: {:?}",
            compiled.warnings
        );
        assert!(compiled.components.is_empty());
    }
}
