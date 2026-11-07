// Prepares a playground script so it reads like mongosh: calls don't need `await`,
// and top-level expressions show their result. Rewrites stay on the same line, so
// error line numbers match the editor.
import * as acorn from 'acorn';
import { ancestor as walkAncestor } from 'acorn-walk';

type AnyNode = acorn.Node & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PARSE_OPTS: acorn.Options = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  locations: true,
};

/** Rewrites `use mydb` and `show dbs` shell lines to function calls, keeping line numbers. */
export function normalizeShellLines(code: string): string {
  return code
    .replace(/^([ \t]*)use[ \t]+([A-Za-z0-9_-]+)[ \t]*;?[ \t]*$/gm, '$1use("$2");')
    .replace(/^([ \t]*)show[ \t]+(dbs|databases|collections|tables)[ \t]*;?[ \t]*$/gm, '$1__showCmd("$2");');
}

export class ScriptSyntaxError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(message);
  }
}

function parse(code: string): acorn.Program {
  try {
    return acorn.parse(code, PARSE_OPTS);
  } catch (err) {
    const e = err as Error & { loc?: { line: number; column: number } };
    throw new ScriptSyntaxError(e.message.replace(/\s*\(\d+:\d+\)$/, ''), e.loc?.line ?? 1, (e.loc?.column ?? 0) + 1);
  }
}

export interface TopLevelStatement { start: number; end: number; line: number; code: string; isUse: boolean }

/** Top-level statements, for "Run" code lenses and running a single statement. */
export function listStatements(rawCode: string): TopLevelStatement[] {
  const code = normalizeShellLines(rawCode);
  // normalizeShellLines changes offsets on rewritten lines, so positions use line numbers.
  const program = parse(code);
  return (program.body as AnyNode[]).map((node) => {
    const text = code.slice(node.start, node.end);
    return {
      start: node.start,
      end: node.end,
      line: node.loc!.start.line,
      code: text,
      isUse: node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression' && node.expression.callee?.name === 'use',
    };
  });
}

interface Edit { pos: number; text: string; order: number }

/** Wraps calls in `await` and top-level expressions in __show(). Returns the code to run. */
export function transformScript(rawCode: string): string {
  const code = normalizeShellLines(rawCode);
  const program = parse(code);
  const edits: Edit[] = [];
  let order = 0;

  const insideSyncFunction = (ancestors: AnyNode[]) =>
    ancestors.some((a) => (a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') && !a.async);

  const wrapAwait = (node: AnyNode) => {
    edits.push({ pos: node.start, text: '(await ', order: order++ });
    edits.push({ pos: node.end, text: ')', order: order++ });
  };

  walkAncestor(program, {
    CallExpression(node: acorn.Node, _state: unknown, ancestors: acorn.Node[]) {
      const n = node as AnyNode;
      const stack = ancestors as AnyNode[];
      if (insideSyncFunction(stack)) return;
      if (stack.some((a) => a.type === 'ChainExpression')) return;
      if (n.callee?.type === 'Super') return;
      if (stack[stack.length - 2]?.type === 'AwaitExpression') return;
      // Callbacks like (x) => x + 1 have no async context here, which is handled above.
      wrapAwait(n);
    },
    ChainExpression(node: acorn.Node, _state: unknown, ancestors: acorn.Node[]) {
      if (!insideSyncFunction(ancestors as AnyNode[])) wrapAwait(node as AnyNode);
    },
  });

  for (const stmt of program.body as AnyNode[]) {
    if (stmt.type !== 'ExpressionStatement') continue;
    const expr = stmt.expression as AnyNode;
    if (expr.type === 'Literal' && typeof expr.value === 'string' && stmt.directive) continue;
    if (expr.type === 'AssignmentExpression' || expr.type === 'UpdateExpression') continue;
    const line = stmt.loc!.start.line;
    const label = code.slice(expr.start, expr.end).split('\n')[0].slice(0, 80);
    // __show must run after the inner await wrappers, so it sits outermost at each position.
    edits.push({ pos: expr.start, text: `await __show(${line}, ${JSON.stringify(label)}, `, order: -1 });
    edits.push({ pos: expr.end, text: ')', order: Number.MAX_SAFE_INTEGER });
  }

  // Apply from the end. At an equal position, closers go before openers. Openers keep
  // their outermost first order, and closers go innermost first.
  const opens = edits.filter((e) => e.text !== ')');
  const closes = edits.filter((e) => e.text === ')');
  let out = '';
  let cursor = 0;
  const positions = [...new Set(edits.map((e) => e.pos))].sort((a, b) => a - b);
  for (const pos of positions) {
    out += code.slice(cursor, pos);
    cursor = pos;
    const closesHere = closes.filter((e) => e.pos === pos).length;
    out += ')'.repeat(closesHere);
    // Outer nodes were visited after their children by the walker, so for equal starts
    // the wrapper with the longer span must open first. Parens are identical text, so
    // only __show has to come first.
    const here = opens.filter((e) => e.pos === pos).sort((a, b) => a.order - b.order);
    out += here.map((e) => e.text).join('');
  }
  out += code.slice(cursor);
  return out;
}

/** Whether a script appears to change data, so we can warn before running on production. */
export function looksLikeWrite(code: string): boolean {
  return /\.(insert|insertOne|insertMany|update|updateOne|updateMany|replaceOne|delete|deleteOne|deleteMany|remove|drop|dropDatabase|dropIndex|dropIndexes|createIndex|createIndexes|createCollection|renameCollection|bulkWrite|findOneAndUpdate|findOneAndReplace|findOneAndDelete|findAndModify|runCommand|adminCommand)\s*\(|\$out\b|\$merge\b/.test(code);
}
