import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const schema = JSON.parse(readFileSync("schemas/redaction-rules.json", "utf8"));
const pythonRules = JSON.parse(
  readFileSync("py/ventora_observability/src/ventora_observability/redaction-rules.json", "utf8"),
);
const tsSource = readFileSync("packages/observability/src/redact.ts", "utf8");

const tsRules = extractDefaultRules(tsSource);

assert.deepEqual(normalizeRules(pythonRules), normalizeRules(schema));
assert.deepEqual(normalizeRules(tsRules), normalizeRules(schema));

function normalizeRules(rules) {
  return {
    fieldKeys: [...rules.fieldKeys].sort(),
    patterns: normalizePatternRules(rules.patterns),
    hipaa18Extensions: normalizePatternRules(rules.hipaa18Extensions ?? []),
    keyPatterns: normalizePatternRules(rules.keyPatterns),
  };
}

function normalizePatternRules(rules) {
  return [...rules]
    .map((rule) => ({
      name: rule.name,
      pattern: rule.pattern,
      replacement: rule.replacement,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractDefaultRules(source) {
  const sourceFile = ts.createSourceFile("redact.ts", source, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "DEFAULT_RULES" &&
        declaration.initializer !== undefined
      ) {
        return readLiteralNode(declaration.initializer);
      }
    }
  }
  throw new Error("DEFAULT_RULES export not found");
}

function readLiteralNode(node) {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return readLiteralNode(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => readLiteralNode(element));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error("DEFAULT_RULES must contain only literal property assignments");
      }
      const key = readPropertyName(property.name);
      value[key] = readLiteralNode(property.initializer);
    }
    return value;
  }
  throw new Error(`DEFAULT_RULES contains non-literal node: ${ts.SyntaxKind[node.kind]}`);
}

function readPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error("DEFAULT_RULES contains a non-literal property name");
}
