import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

/**
 * Structural regression test for a real architectural guarantee: the
 * `action === 'edit'` branch in app/api/chat/route.ts must NEVER call
 * generateProject/createFreshProject (the full-regeneration path) — an
 * existing project must always be repaired via discoverProject +
 * computeEditScope + targeted file edits, never rebuilt from scratch.
 *
 * This is a STATIC/structural test rather than a runtime one deliberately:
 * fully exercising this route handler at runtime would require mocking
 * auth, credit-wallet, Bedrock, and file-system state just to prove one
 * narrow claim ("this branch never calls that function") — a much higher
 * cost for the same guarantee. Uses the TypeScript compiler API (not a
 * text/regex scan) for the same reason established in
 * scripts/check-platform-deps.ts: a naive text search could be fooled by a
 * comment or string mentioning "generateProject", or miss a real call
 * split across lines — parsing the real AST and finding the actual `if
 * (action === 'edit')` statement's CallExpressions sidesteps that.
 */

const ROUTE_FILE = join(process.cwd(), 'app/api/chat/route.ts');

function findEditBlockCallNames(): Set<string> {
  const content = readFileSync(ROUTE_FILE, 'utf8');
  const sourceFile = ts.createSourceFile(ROUTE_FILE, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  let editBlock: ts.Statement | null = null;

  function findEditIf(node: ts.Node) {
    if (editBlock) return;
    if (ts.isIfStatement(node) && isActionEqualsEdit(node.expression)) {
      editBlock = node.thenStatement;
      return;
    }
    ts.forEachChild(node, findEditIf);
  }
  function isActionEqualsEdit(expr: ts.Expression): boolean {
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    const { left, right } = expr;
    const isActionIdent = (n: ts.Expression) => ts.isIdentifier(n) && n.text === 'action';
    const isEditLiteral = (n: ts.Expression) => ts.isStringLiteral(n) && n.text === 'edit';
    return (isActionIdent(left) && isEditLiteral(right)) || (isActionIdent(right) && isEditLiteral(left));
  }

  findEditIf(sourceFile);
  if (!editBlock) throw new Error(`Could not find "if (action === 'edit')" in ${ROUTE_FILE} — has this route been restructured?`);

  const callNames = new Set<string>();
  function collectCalls(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) callNames.add(expr.text);
      else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) callNames.add(expr.name.text);
    }
    ts.forEachChild(node, collectCalls);
  }
  collectCalls(editBlock);
  return callNames;
}

describe('app/api/chat/route.ts — action:"edit" never rebuilds from scratch', () => {
  it('the edit branch never calls generateProject', () => {
    const calls = findEditBlockCallNames();
    expect(calls.has('generateProject')).toBe(false);
  });

  it('the edit branch never calls createFreshProject', () => {
    const calls = findEditBlockCallNames();
    expect(calls.has('createFreshProject')).toBe(false);
  });

  it('the edit branch DOES use discoverProject (the existing-project read path) — sanity check that this test found the real block', () => {
    const calls = findEditBlockCallNames();
    expect(calls.has('discoverProject')).toBe(true);
  });
});
