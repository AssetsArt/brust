import ts from 'typescript'

/**
 * Return true only when the entry contains a statically provable
 * `brust.run({ ..., ai: true })` call through a named import from `brustjs`.
 */
export function entryHasLiteralAiOptIn(entry: string): boolean {
  const program = ts.createProgram({
    rootNames: [entry],
    options: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      noResolve: true,
      target: ts.ScriptTarget.Latest,
    },
  })
  const source = program.getSourceFile(entry)
  if (!source) return false
  const checker = program.getTypeChecker()
  const brustBindings = new Set<ts.Symbol>()

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'brustjs'
    ) {
      continue
    }
    const importClause = statement.importClause
    if (!importClause || importClause.isTypeOnly) continue
    const bindings = importClause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue
      if ((element.propertyName ?? element.name).text === 'brust') {
        const symbol = checker.getSymbolAtLocation(element.name)
        if (symbol) brustBindings.add(symbol)
      }
    }
  }

  let enabled = false
  const visit = (node: ts.Node): void => {
    if (enabled) return
    const receiver =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
        ? node.expression.expression
        : undefined
    const receiverSymbol = receiver ? checker.getSymbolAtLocation(receiver) : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'run' &&
      receiverSymbol &&
      brustBindings.has(receiverSymbol)
    ) {
      const options = node.arguments[0]
      if (options && ts.isObjectLiteralExpression(options) && hasLiteralAiTrue(options)) {
        enabled = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return enabled
}

function hasLiteralAiTrue(options: ts.ObjectLiteralExpression): boolean {
  let initializer: ts.Expression | undefined
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) return false
    const name = property.name
    const propertyName =
      name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined
    if (propertyName !== 'ai') continue
    if (!ts.isPropertyAssignment(property)) return false
    initializer = property.initializer
  }
  return initializer?.kind === ts.SyntaxKind.TrueKeyword
}
