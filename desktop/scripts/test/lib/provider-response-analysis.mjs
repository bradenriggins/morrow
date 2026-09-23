import ts from "@typescript/typescript6";

/**
 * Data-flow analysis of one provider source file for the two response-body
 * invariants the Bridge relies on:
 *
 * 1. A body or reader cancellation is never waited on. Cancellation runs
 *    provider-controlled cleanup that may never settle, so a terminal path
 *    that waits on it can be held open forever. The rule follows the promise
 *    wherever it flows: a direct `await`, a variable awaited later, a
 *    `.catch`/`.then` chain, a `Promise.all`-style combinator, or a helper
 *    whose return value is the cancellation.
 * 2. Every exit taken while a fetch response is live and its body not yet
 *    consumed cancels that body on that same path. A response is live from
 *    the statement that produces it (or from function entry for a parameter)
 *    until its body is handed to a reader, a whole-body decoder, or another
 *    function. Only a response with no body at all may be abandoned.
 *
 * Both rules are decided on the syntax tree, not on text windows, so renaming
 * a helper, moving a line, or negating a condition differently cannot hide
 * the forbidden path.
 */

const CONSUMER_METHODS = new Set(["getReader", "arrayBuffer", "text", "json", "blob", "formData", "pipeTo", "pipeThrough", "tee"]);
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
const PROMISE_CHAIN = new Set(["catch", "then", "finally"]);
const BRANCHING = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);

function unwrap(node) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))
  )) current = current.expression;
  return current;
}

function isFunctionWithBody(node) {
  return Boolean(node) && ts.isFunctionLike(node) && node.body !== undefined;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current && !isFunctionWithBody(current)) current = current.parent;
  return current ?? null;
}

/** Visits every node under `root` without entering nested functions. */
function forEachOwnNode(root, visit) {
  const walk = (node) => {
    if (visit(node) === false) return;
    ts.forEachChild(node, (child) => {
      if (isFunctionWithBody(child)) return;
      walk(child);
    });
  };
  ts.forEachChild(root, (child) => {
    if (isFunctionWithBody(child)) return;
    walk(child);
  });
}

function forEachNode(root, visit) {
  const walk = (node) => {
    if (visit(node) === false) return;
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function calleeProperty(call) {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
}

function calleeObject(call) {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) ? unwrap(callee.expression) : null;
}

function calleeIdentifier(call) {
  const callee = unwrap(call.expression);
  return ts.isIdentifier(callee) ? callee.text : null;
}

function isCancelCall(node) {
  return ts.isCallExpression(node) && calleeProperty(node) === "cancel";
}

function isFetchCall(node) {
  return ts.isCallExpression(node) && calleeIdentifier(node) === "fetch";
}

function isPromiseCombinator(call) {
  const object = calleeObject(call);
  return Boolean(object) && ts.isIdentifier(object) && object.text === "Promise" && PROMISE_COMBINATORS.has(calleeProperty(call));
}

function containsNode(root, predicate) {
  let found = false;
  forEachNode(root, (node) => {
    if (found) return false;
    if (predicate(node)) { found = true; return false; }
    return true;
  });
  return found;
}

/** Every return value of a function, including an expression-bodied arrow. */
function returnExpressions(fn) {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const output = [];
  forEachOwnNode(fn.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) output.push(node.expression);
  });
  return output;
}

/** Every named function in the file: declarations and function-valued constants. */
function namedFunctions(sourceFile) {
  const functions = new Map();
  forEachNode(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body) {
        functions.set(node.name.text, initializer);
      }
    }
  });
  return functions;
}

/** Declarations and assignments of every identifier inside one function body, outermost scope first. */
class Scope {
  constructor(fn, sourceFile) {
    this.fn = fn;
    this.sourceFile = sourceFile;
    this.bindings = new Map();
    this.productions = new Map();
    this.assignments = new Map();
    const root = isFunctionWithBody(fn) ? fn.body : fn;
    forEachOwnNode(root, (node) => {
      let name = null;
      let value = null;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        name = node.name.text;
        value = node.initializer;
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        name = node.left.text;
        value = node.right;
      }
      if (!name) return;
      const assignments = this.assignments.get(name) || [];
      assignments.push({ node, value });
      this.assignments.set(name, assignments);
      const known = this.bindings.get(name);
      if (!known || node.pos < known.pos) this.bindings.set(name, value);
      let statement = node;
      while (statement && !ts.isStatement(statement)) statement = statement.parent;
      const production = this.productions.get(name);
      if (statement && (!production || statement.pos < production.pos)) this.productions.set(name, statement);
    });
  }

  isParameter(name) {
    return isFunctionWithBody(this.fn) && this.fn.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);
  }
}

class Analysis {
  constructor(sourceFile) {
    this.sourceFile = sourceFile;
    this.functions = namedFunctions(sourceFile);
    this.scopes = new Map();
    this.returnsCancellation = new Set();
    this.cancelling = new Set();
    this.reading = new Set();
    this.returnsFetch = new Set();
    this.#settle();
  }

  scope(fn) {
    let scope = this.scopes.get(fn);
    if (!scope) {
      scope = new Scope(fn, this.sourceFile);
      this.scopes.set(fn, scope);
    }
    return scope;
  }

  /** The nearest binding of `name` visible from `from`, searching enclosing functions outward. */
  bindingOf(name, from) {
    let fn = enclosingFunction(from) ?? this.sourceFile;
    for (;;) {
      const scope = this.scope(fn);
      if (scope.isParameter(name)) return null;
      const binding = scope.bindings.get(name);
      if (binding) return binding;
      if (fn === this.sourceFile) return null;
      fn = enclosingFunction(fn) ?? this.sourceFile;
    }
  }

  #settle() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, fn] of this.functions) {
        if (!this.cancelling.has(name) && containsNode(fn.body, (node) => this.isCancellationCall(node))) {
          this.cancelling.add(name);
          changed = true;
        }
        if (!this.reading.has(name) && containsNode(fn.body, (node) => this.isReadingCall(node))) {
          this.reading.add(name);
          changed = true;
        }
        if (!this.returnsCancellation.has(name) && returnExpressions(fn).some((expression) => this.isCancellation(expression))) {
          this.returnsCancellation.add(name);
          changed = true;
        }
        if (!this.returnsFetch.has(name) && returnExpressions(fn).some((expression) => this.isFetchDerived(expression))) {
          this.returnsFetch.add(name);
          changed = true;
        }
      }
    }
  }

  /** Whether `node` evaluates to a body or reader cancellation promise. */
  isCancellation(node, depth = 0) {
    if (!node || depth > 12) return false;
    const expression = unwrap(node);
    if (ts.isAwaitExpression(expression)) return this.isCancellation(expression.expression, depth + 1);
    if (ts.isCallExpression(expression)) {
      if (isCancelCall(expression)) return true;
      const property = calleeProperty(expression);
      if (property && PROMISE_CHAIN.has(property)) return this.isCancellation(calleeObject(expression), depth + 1);
      if (isPromiseCombinator(expression)) {
        const [argument] = expression.arguments;
        const list = argument ? unwrap(argument) : null;
        return Boolean(list) && ts.isArrayLiteralExpression(list) && list.elements.some((element) => this.isCancellation(element, depth + 1));
      }
      const identifier = calleeIdentifier(expression);
      return Boolean(identifier) && this.returnsCancellation.has(identifier);
    }
    if (ts.isIdentifier(expression)) return this.isCancellation(this.bindingOf(expression.text, expression), depth + 1);
    if (ts.isConditionalExpression(expression)) {
      return this.isCancellation(expression.whenTrue, depth + 1) || this.isCancellation(expression.whenFalse, depth + 1);
    }
    if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(expression.operatorToken.kind)) {
      return this.isCancellation(expression.left, depth + 1) || this.isCancellation(expression.right, depth + 1);
    }
    return false;
  }

  /** Whether `node` evaluates to the result of `fetch`, directly or through a local helper. */
  isFetchDerived(node, depth = 0) {
    if (!node || depth > 12) return false;
    const expression = unwrap(node);
    if (ts.isAwaitExpression(expression)) return this.isFetchDerived(expression.expression, depth + 1);
    if (ts.isCallExpression(expression)) {
      if (isFetchCall(expression)) return true;
      const identifier = calleeIdentifier(expression);
      return Boolean(identifier) && this.returnsFetch.has(identifier);
    }
    if (ts.isIdentifier(expression)) return this.isFetchDerived(this.bindingOf(expression.text, expression), depth + 1);
    if (ts.isConditionalExpression(expression)) {
      return this.isFetchDerived(expression.whenTrue, depth + 1) || this.isFetchDerived(expression.whenFalse, depth + 1);
    }
    return false;
  }

  /** Whether a call is a cancellation of a body or reader, directly or through a local helper. */
  isCancellationCall(node) {
    return ts.isCallExpression(node) && (isCancelCall(node) || this.cancelling.has(calleeIdentifier(node)));
  }

  /** Whether a call reads a body: a consumer method, or a local helper that reads one. */
  isReadingCall(node) {
    if (!ts.isCallExpression(node)) return false;
    const property = calleeProperty(node);
    return (property !== null && CONSUMER_METHODS.has(property)) || this.reading.has(calleeIdentifier(node));
  }

  /** Whether a call only cancels: it never hands the body to a reader. */
  isPureCancellation(node) {
    return this.isCancellationCall(node) && !this.isReadingCall(node);
  }

  line(node) {
    return this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile)).line + 1;
  }
}

/** Terminal paths that wait on a cancellation promise. */
function awaitedCancellations(analysis) {
  const findings = [];
  forEachNode(analysis.sourceFile, (node) => {
    if (ts.isAwaitExpression(node) && analysis.isCancellation(node.expression)) {
      findings.push({ line: analysis.line(node), reason: "awaits a cancellation" });
      return;
    }
    if (ts.isForOfStatement(node) && node.awaitModifier && analysis.isCancellation(node.expression)) {
      findings.push({ line: analysis.line(node), reason: "iterates a cancellation with for await" });
      return;
    }
    if (isFunctionWithBody(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      for (const expression of returnExpressions(node)) {
        if (analysis.isCancellation(expression)) {
          findings.push({ line: analysis.line(expression), reason: "an async function settles with a cancellation" });
        }
      }
    }
  });
  return findings;
}

/**
 * The identifier a member chain starts from, following `const body = response.body`
 * style aliases declared in the same function. Reports whether the chain
 * passes through `.body`.
 */
function chainRoot(expression, scope, depth = 0) {
  let current = unwrap(expression);
  let viaBody = false;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      if (current.name.text === "body") viaBody = true;
      current = unwrap(current.expression);
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = unwrap(current.expression);
      continue;
    }
    break;
  }
  if (!ts.isIdentifier(current)) return null;
  const alias = depth < 8 && !scope.isParameter(current.text) ? scope.bindings.get(current.text) : undefined;
  if (alias) {
    const target = unwrap(alias);
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      const inner = chainRoot(target, scope, depth + 1);
      return inner ? { name: inner.name, viaBody: viaBody || inner.viaBody } : null;
    }
  }
  return { name: current.text, viaBody };
}

function referencesIdentifier(node, name) {
  return containsNode(node, (candidate) => ts.isIdentifier(candidate) && candidate.text === name
    && !(candidate.parent && ts.isPropertyAccessExpression(candidate.parent) && candidate.parent.name === candidate));
}

/**
 * Whether `expression` proves there is no body to cancel: exactly `!name`
 * (no response at all), `!name.body`, `name.body === null`, a body with no
 * reader, `name.type === "opaqueredirect"` (an opaque-redirect filtered
 * response carries a null body by specification), or an `||` of such tests.
 */
function isBodyAbsenceTest(expression, name, scope, depth = 0) {
  const test = unwrap(expression);
  if (depth > 8) return false;
  const isResponse = (node) => ts.isIdentifier(unwrap(node)) && unwrap(node).text === name;
  const isBodyOf = (node) => {
    const access = unwrap(node);
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== "body") return false;
    const root = chainRoot(access.expression, scope);
    return Boolean(root) && root.name === name && !root.viaBody;
  };
  if (ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return isBodyAbsenceTest(test.left, name, scope, depth + 1) && isBodyAbsenceTest(test.right, name, scope, depth + 1);
  }
  if (ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken) {
    return isResponse(test.operand) || isBodyOf(test.operand);
  }
  if (ts.isBinaryExpression(test)
    && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(test.operatorToken.kind)) {
    const equality = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(test.operatorToken.kind);
    const [left, right] = [unwrap(test.left), unwrap(test.right)];
    const isNullish = (node) => node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined");
    if (equality && ((isNullish(right) && isBodyOf(left)) || (isNullish(left) && isBodyOf(right)))) return true;
    const [access, literal] = ts.isStringLiteral(right) ? [left, right] : [right, left];
    if (!ts.isStringLiteral(literal)) return false;
    if (equality && literal.text === "opaqueredirect" && ts.isPropertyAccessExpression(access) && access.name.text === "type") {
      const root = chainRoot(access.expression, scope);
      return Boolean(root) && root.name === name && !root.viaBody;
    }
    if (!equality && literal.text === "function" && ts.isTypeOfExpression(access)) {
      const operand = unwrap(access.expression);
      return ts.isPropertyAccessExpression(operand) && operand.name.text === "getReader" && isBodyOf(operand.expression);
    }
  }
  return false;
}

/** Whether an exit runs only when the response has no body, so nothing is left live. */
function guardedByBodyAbsence(exit, name, scope, fn) {
  let current = exit;
  while (current && current !== fn.body) {
    const parent = current.parent;
    if (parent && ts.isIfStatement(parent) && parent.thenStatement === current && isBodyAbsenceTest(parent.expression, name, scope)) return true;
    current = parent;
  }
  return false;
}

/**
 * The catch clauses of every try statement around the production of a
 * response. An exit there answers a failure thrown elsewhere; the statement
 * that threw is the path that had to cancel.
 */
function guardingCatches(statement, fn) {
  const clauses = [];
  let current = statement;
  while (current && current !== fn.body) {
    const parent = current.parent;
    if (parent && ts.isTryStatement(parent) && parent.tryBlock === current && parent.catchClause) clauses.push(parent.catchClause);
    current = parent;
  }
  return clauses;
}

function withinAny(node, containers) {
  return containers.some((container) => node.pos >= container.pos && node.end <= container.end);
}

/** The statements of the innermost list that contains `node`, and the index of the one holding it. */
function statementList(node) {
  let statement = node;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)
    && !ts.isCaseClause(statement.parent) && !ts.isDefaultClause(statement.parent) && !ts.isModuleBlock(statement.parent)) {
    statement = statement.parent;
  }
  const statements = statement.parent ? [...statement.parent.statements] : [];
  return { statements, index: statements.indexOf(statement), statement };
}

/**
 * Whether `statement` cancels on every path through it: a cancellation that
 * sits under a branch, loop, or catch clause of the statement runs only on
 * that branch and does not count. The exit statement itself is searched in
 * full because everything inside it runs on the exit path.
 */
function cancelsUnconditionally(statement, analysis, entire) {
  if (!entire && BRANCHING.has(statement.kind)) return false;
  let found = false;
  forEachOwnNode(statement, (node) => {
    if (found) return false;
    if (analysis.isCancellationCall(node)) { found = true; return false; }
    if (!entire && node !== statement && BRANCHING.has(node.kind)) return false;
    if (!entire && ts.isBinaryExpression(node)
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      // Only the left operand always runs.
      if (containsNode(node.left, (candidate) => analysis.isCancellationCall(candidate))) found = true;
      return false;
    }
    return true;
  });
  if (!found && analysis.isCancellationCall(statement)) found = true;
  return found;
}

function responseDispositionCall(node, name, scope, analysis) {
  if (!ts.isCallExpression(node) || (!analysis.isReadingCall(node) && !analysis.isCancellationCall(node))) return false;
  const object = calleeObject(node);
  if (object) {
    const root = chainRoot(object, scope);
    if (root?.name === name) return true;
  }
  return node.arguments.some((argument) => {
    const value = unwrap(argument);
    if (ts.isIdentifier(value) && value.text === name) return true;
    return chainRoot(argument, scope)?.name === name;
  });
}

function disposesResponseUnconditionally(statement, name, scope, analysis) {
  if (BRANCHING.has(statement.kind)) return false;
  let found = false;
  forEachOwnNode(statement, (node) => {
    if (found) return false;
    if (responseDispositionCall(node, name, scope, analysis)) { found = true; return false; }
    if (node !== statement && BRANCHING.has(node.kind)) return false;
    return true;
  });
  return found;
}

function repeatingLoop(node, fn) {
  let current = node;
  while (current && current !== fn.body) {
    if (ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)
      || ts.isWhileStatement(current) || ts.isDoStatement(current)) return current;
    current = current.parent;
  }
  return null;
}

/** Fetch assignments that can replace a response before its prior body is disposed. */
function overwrittenResponses(analysis) {
  const findings = [];
  forEachNode(analysis.sourceFile, (fn) => {
    if (!isFunctionWithBody(fn) || !ts.isBlock(fn.body)) return;
    const scope = analysis.scope(fn);
    for (const [name, assignments] of scope.assignments) {
      const fetches = assignments.filter(({ value }) => !ts.isIdentifier(unwrap(value)) && analysis.isFetchDerived(value));
      for (let index = 0; index < fetches.length; index += 1) {
        const current = fetches[index];
        let statement = current.node;
        while (statement && !ts.isStatement(statement)) statement = statement.parent;
        if (!statement) continue;
        const list = statementList(statement);
        const next = fetches.slice(index + 1).find(({ node }) => node.getStart(analysis.sourceFile) > current.node.getStart(analysis.sourceFile));
        if (next) {
          let nextStatement = next.node;
          while (nextStatement && !ts.isStatement(nextStatement)) nextStatement = nextStatement.parent;
          if (nextStatement?.parent === list.statement.parent) {
            const nextIndex = list.statements.indexOf(nextStatement);
            const disposed = list.statements.slice(list.index + 1, nextIndex)
              .some((candidate) => disposesResponseUnconditionally(candidate, name, scope, analysis));
            if (!disposed) findings.push({ line: analysis.line(next.node), reason: `overwrites live ${name} without cancelling its body` });
          }
        }
        const loop = repeatingLoop(statement, fn);
        if (!loop || !ts.isBlock(loop.statement) || statement.parent !== loop.statement) continue;
        const disposed = list.statements.slice(list.index + 1)
          .some((candidate) => disposesResponseUnconditionally(candidate, name, scope, analysis));
        if (!disposed) findings.push({ line: analysis.line(current.node), reason: `can overwrite live ${name} on the next iteration` });
      }
    }
  });
  return findings;
}

/**
 * Exits that abandon a live fetch response before its body is consumed and do
 * not cancel it on that path. A response is one produced by `fetch` (directly
 * or through a local helper) or a parameter whose body this function reads.
 */
function unconsumedExits(analysis) {
  const findings = [];
  forEachNode(analysis.sourceFile, (fn) => {
    if (!isFunctionWithBody(fn) || !ts.isBlock(fn.body)) return;
    const scope = analysis.scope(fn);
    const responses = new Set();
    const consumedAt = new Map();
    const note = (name, node) => {
      const position = node.getStart(analysis.sourceFile);
      const known = consumedAt.get(name);
      if (known === undefined || position < known) consumedAt.set(name, position);
    };
    // Responses this function produced through fetch.
    for (const [name, value] of scope.bindings) {
      if (!scope.isParameter(name) && analysis.isFetchDerived(value)) responses.add(name);
    }
    // Responses this function received and reads as a body.
    forEachOwnNode(fn.body, (node) => {
      if (!ts.isCallExpression(node)) return;
      const property = calleeProperty(node);
      if (property && CONSUMER_METHODS.has(property)) {
        const root = chainRoot(calleeObject(node), scope);
        if (root && (root.viaBody || property !== "getReader")) {
          if (root.viaBody && scope.isParameter(root.name)) responses.add(root.name);
          note(root.name, node);
        }
      } else if (property === "get") {
        const root = chainRoot(calleeObject(node), scope);
        const object = calleeObject(node);
        if (root && scope.isParameter(root.name) && ts.isPropertyAccessExpression(object) && object.name.text === "headers") responses.add(root.name);
      }
    });
    if (responses.size === 0) return;
    // Handing a response, or its body, to another function consumes it there.
    // A call that only cancels is not consumption: the body stays live for the
    // paths that do not take it.
    forEachOwnNode(fn.body, (node) => {
      if (!ts.isCallExpression(node) || analysis.isPureCancellation(node)) return;
      const property = calleeProperty(node);
      if (property && CONSUMER_METHODS.has(property)) return;
      for (const argument of node.arguments) {
        const value = unwrap(argument);
        if (ts.isIdentifier(value) && responses.has(value.text)) { note(value.text, node); continue; }
        const root = chainRoot(argument, scope);
        if (root && root.viaBody && responses.has(root.name)) note(root.name, node);
      }
    });
    for (const name of responses) {
      const end = consumedAt.get(name);
      if (end === undefined) continue;
      const parameter = scope.isParameter(name);
      const production = parameter ? null : scope.productions.get(name);
      if (!parameter && !production) continue;
      const availableFrom = parameter ? fn.body.getStart(analysis.sourceFile) : production.end;
      if (availableFrom >= end) continue;
      const excluded = production ? guardingCatches(production, fn) : [];
      forEachOwnNode(fn.body, (node) => {
        if (!ts.isReturnStatement(node) && !ts.isThrowStatement(node)) return;
        const at = node.getStart(analysis.sourceFile);
        if (at <= availableFrom || at >= end || withinAny(node, excluded)) return;
        if (node.expression && referencesIdentifier(node.expression, name)) return;
        if (guardedByBodyAbsence(node, name, scope, fn)) return;
        const { statements, index } = statementList(node);
        const cancelled = statements.slice(0, index).some((statement) => cancelsUnconditionally(statement, analysis, false))
          || cancelsUnconditionally(statements[index], analysis, true);
        if (!cancelled) findings.push({ line: analysis.line(node), reason: `leaves ${name} live without cancelling its body` });
      });
    }
  });
  return findings;
}

/** Runs both invariants over one source file and returns sorted `line:reason` findings. */
export function analyseProviderSource(name, source) {
  const kind = name.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);
  const analysis = new Analysis(sourceFile);
  const describe = (findings) => [...new Set(findings.map((finding) => `${finding.line}:${finding.reason}`))]
    .sort((left, right) => Number(left.split(":")[0]) - Number(right.split(":")[0]));
  return {
    awaitedCancellations: describe(awaitedCancellations(analysis)),
    unconsumedExits: describe([...unconsumedExits(analysis), ...overwrittenResponses(analysis)]),
  };
}
