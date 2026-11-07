// A small, safe parser for the MongoDB shell's literal syntax:
//   { status: "active", age: { $gte: 18 }, _id: ObjectId("..."), at: new Date() }
// It never evaluates code. It is dependency-free so the webview can use it for
// live validation and highlighting; src/core/bsonCodec.ts turns its AST into BSON.

export interface Loc { start: number; end: number }

export type Node = Loc & (
  | { k: 'object'; entries: { key: string; keyLoc: Loc; value: Node }[] }
  | { k: 'array'; items: Node[] }
  | { k: 'string'; v: string }
  | { k: 'number'; v: number; raw: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'undefined' }
  | { k: 'regex'; pattern: string; flags: string }
  | { k: 'call'; name: string; args: Node[] }
);

export class ShellSyntaxError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, readonly pos: number, readonly end: number, src: string) {
    super(message);
    this.name = 'ShellSyntaxError';
    const before = src.slice(0, pos);
    this.line = before.split('\n').length;
    this.col = pos - before.lastIndexOf('\n');
  }
}

export type TokenType = 'punct' | 'string' | 'number' | 'ident' | 'regex' | 'comment' | 'error' | 'op';
export interface Token extends Loc { type: TokenType; text: string }

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdPart = (c: string) => /[\w$.\-]/.test(c);

/** Tokenizes without throwing. Unknown characters become `error` tokens. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (type: TokenType, start: number) => out.push({ type, start, end: i, text: src.slice(start, i) });
  while (i < src.length) {
    const c = src[i];
    const start = i;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      push('comment', start);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 2;
      push('comment', start);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; closed = true; break; }
        if (src[i] === '\n' && c !== '`') break;
        i++;
      }
      i = Math.min(i, src.length);
      push(closed ? 'string' : 'error', start);
      continue;
    }
    if (c === '/') {
      i++;
      let inClass = false;
      let closed = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; closed = true; break; }
        i++;
      }
      i = Math.min(i, src.length);
      if (closed) while (i < src.length && /[a-z]/i.test(src[i])) i++;
      push(closed ? 'regex' : 'error', start);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      if (c === '0' && /[xX]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < src.length && /[0-9a-fA-F]/.test(src[i])) i++;
      } else {
        while (i < src.length && /[0-9_]/.test(src[i])) i++;
        if (src[i] === '.') { i++; while (i < src.length && /[0-9_]/.test(src[i])) i++; }
        if (/[eE]/.test(src[i] ?? '')) {
          let j = i + 1;
          if (/[+-]/.test(src[j] ?? '')) j++;
          if (/[0-9]/.test(src[j] ?? '')) {
            i = j;
            while (i < src.length && /[0-9]/.test(src[i])) i++;
          }
        }
      }
      push('number', start);
      continue;
    }
    if (isIdStart(c)) {
      i++;
      while (i < src.length && isIdPart(src[i])) i++;
      push('ident', start);
      continue;
    }
    if ('{}[]():,'.includes(c)) { i++; push('punct', start); continue; }
    if ('+-*'.includes(c)) { i++; push('op', start); continue; }
    i++;
    push('error', start);
  }
  return out;
}

export type HighlightClass = 'key' | 'operator' | 'string' | 'number' | 'constant' | 'func' | 'regex' | 'comment' | 'punct' | 'error' | 'ident';

/** Classifies tokens for syntax highlighting. */
export function highlight(src: string): { cls: HighlightClass; start: number; end: number }[] {
  const toks = tokenize(src);
  const significant = toks.filter((t) => t.type !== 'comment');
  const nextSig = new Map<Token, Token | undefined>();
  significant.forEach((t, idx) => nextSig.set(t, significant[idx + 1]));
  return toks.map((t) => {
    const next = nextSig.get(t);
    let cls: HighlightClass;
    switch (t.type) {
      case 'comment': cls = 'comment'; break;
      case 'regex': cls = 'regex'; break;
      case 'number': cls = 'number'; break;
      case 'error': cls = 'error'; break;
      case 'punct': case 'op': cls = 'punct'; break;
      case 'string':
        cls = next?.text === ':' ? (t.text.slice(1, 2) === '$' ? 'operator' : 'key') : 'string';
        break;
      default:
        if (next?.text === ':') cls = t.text.startsWith('$') ? 'operator' : 'key';
        else if (t.text.startsWith('$')) cls = 'operator';
        else if (next?.text === '(' || t.text === 'new') cls = 'func';
        else if (['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(t.text)) cls = 'constant';
        else cls = 'ident';
    }
    return { cls, start: t.start, end: t.end };
  });
}

function unescapeString(raw: string): string {
  const body = raw.slice(1, -1);
  if (!body.includes('\\')) return body;
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (_, e: string) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case '\n': case '\r': return '';
      case 'x': return String.fromCharCode(parseInt(e.slice(1), 16));
      case 'u':
        return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
      default: return e;
    }
  });
}

export const SHELL_HELPERS = [
  'ObjectId', 'ISODate', 'Date', 'NumberInt', 'NumberLong', 'NumberDecimal', 'Decimal128', 'Long', 'Int32', 'Double',
  'UUID', 'BinData', 'HexData', 'Binary', 'Timestamp', 'MinKey', 'MaxKey', 'RegExp', 'Code', 'DBRef', 'BSONSymbol',
] as const;
const HELPER_ALIASES: Record<string, string> = { ObjectID: 'ObjectId', Int: 'Int32', Decimal: 'Decimal128' };

class Parser {
  private toks: Token[];
  private i = 0;
  constructor(private src: string) {
    this.toks = tokenize(src).filter((t) => t.type !== 'comment');
  }
  private peek(): Token | undefined { return this.toks[this.i]; }
  private next(): Token | undefined { return this.toks[this.i++]; }
  private endPos(): number { return this.src.length; }
  private err(msg: string, t?: Loc): ShellSyntaxError {
    return new ShellSyntaxError(msg, t ? t.start : this.endPos(), t ? t.end : this.endPos(), this.src);
  }
  private isPunct(text: string): boolean {
    const t = this.peek();
    return !!t && t.type === 'punct' && t.text === text;
  }
  private describe(t: Token | undefined): string {
    return t ? `'${t.text.length > 24 ? t.text.slice(0, 24) + '…' : t.text}'` : 'the end of the input';
  }

  parseAll(): Node {
    const node = this.parseExpr();
    const extra = this.peek();
    if (extra) throw this.err(`Unexpected ${this.describe(extra)} after the end of the value.`, extra);
    return node;
  }

  private parseExpr(): Node {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.type !== 'op' || t.text === '*') return left;
      this.next();
      const right = this.parseTerm();
      left = this.fold(left, right, t);
    }
  }
  private parseTerm(): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.type !== 'op' || t.text !== '*') return left;
      this.next();
      const right = this.parseUnary();
      left = this.fold(left, right, t);
    }
  }
  private fold(a: Node, b: Node, op: Token): Node {
    if (a.k !== 'number' || b.k !== 'number') throw this.err(`'${op.text}' only works between numbers here.`, op);
    const v = op.text === '+' ? a.v + b.v : op.text === '-' ? a.v - b.v : a.v * b.v;
    return { k: 'number', v, raw: String(v), start: a.start, end: b.end };
  }
  private parseUnary(): Node {
    const t = this.peek();
    if (t?.type === 'op' && (t.text === '-' || t.text === '+')) {
      this.next();
      const v = this.parseUnary();
      if (v.k !== 'number') throw this.err(`'${t.text}' must be followed by a number.`, t);
      return t.text === '-'
        ? { k: 'number', v: -v.v, raw: '-' + v.raw, start: t.start, end: v.end }
        : { ...v, start: t.start };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (!t) throw this.err('Unexpected end of input: a value is missing or a bracket was not closed.');
    switch (t.type) {
      case 'string': return { k: 'string', v: unescapeString(t.text), start: t.start, end: t.end };
      case 'number': {
        const clean = t.text.replace(/_/g, '');
        const v = Number(clean);
        if (Number.isNaN(v)) throw this.err(`Invalid number ${t.text}.`, t);
        return { k: 'number', v, raw: clean, start: t.start, end: t.end };
      }
      case 'regex': {
        const close = t.text.lastIndexOf('/');
        return { k: 'regex', pattern: t.text.slice(1, close), flags: t.text.slice(close + 1), start: t.start, end: t.end };
      }
      case 'error':
        if (t.text[0] === '"' || t.text[0] === "'" || t.text[0] === '`') throw this.err('This string is missing its closing quote.', t);
        if (t.text[0] === '/') throw this.err('This regular expression is missing its closing /.', t);
        throw this.err(`Unexpected character ${this.describe(t)}.`, t);
      case 'punct':
        if (t.text === '{') return this.parseObject(t);
        if (t.text === '[') return this.parseArray(t);
        if (t.text === '(') {
          const inner = this.parseExpr();
          if (!this.isPunct(')')) throw this.err(`Expected ')' but found ${this.describe(this.peek())}.`, this.peek());
          this.next();
          return inner;
        }
        throw this.err(`Unexpected ${this.describe(t)}: a value was expected.`, t);
      case 'ident': return this.parseIdent(t);
      default: throw this.err(`Unexpected ${this.describe(t)}.`, t);
    }
  }

  private parseIdent(t: Token): Node {
    const name = t.text;
    if (name === 'true' || name === 'false') return { k: 'bool', v: name === 'true', start: t.start, end: t.end };
    if (name === 'null') return { k: 'null', start: t.start, end: t.end };
    if (name === 'undefined') return { k: 'undefined', start: t.start, end: t.end };
    if (name === 'NaN') return { k: 'number', v: NaN, raw: 'NaN', start: t.start, end: t.end };
    if (name === 'Infinity') return { k: 'number', v: Infinity, raw: 'Infinity', start: t.start, end: t.end };
    if (name === 'new') {
      const ctor = this.next();
      if (ctor?.type !== 'ident') throw this.err(`'new' must be followed by a type such as Date or ObjectId.`, ctor ?? t);
      return this.parseCall(ctor);
    }
    if (name === 'Date.now') {
      this.parseArgs(t);
      const v = Date.now();
      return { k: 'number', v, raw: String(v), start: t.start, end: this.toks[this.i - 1].end };
    }
    if (this.isPunct('(')) return this.parseCall(t);
    throw this.err(`Unknown value '${name}'. If this is a string, put it in quotes: "${name}".`, t);
  }

  private parseArgs(nameTok: Token): Node[] {
    if (!this.isPunct('(')) throw this.err(`Expected '(' after ${nameTok.text}.`, this.peek() ?? nameTok);
    this.next();
    const args: Node[] = [];
    while (!this.isPunct(')')) {
      if (!this.peek()) throw this.err(`The call to ${nameTok.text}() is missing its closing ')'.`);
      args.push(this.parseExpr());
      if (this.isPunct(',')) this.next();
      else if (!this.isPunct(')')) throw this.err(`Expected ',' or ')' but found ${this.describe(this.peek())}.`, this.peek());
    }
    this.next();
    return args;
  }

  private parseCall(nameTok: Token): Node {
    const name = HELPER_ALIASES[nameTok.text] ?? nameTok.text;
    if (!(SHELL_HELPERS as readonly string[]).includes(name)) {
      throw this.err(`Unknown function ${nameTok.text}(). Only literal helpers such as ObjectId() and ISODate() are allowed here.`, nameTok);
    }
    const args = name === 'Date' && !this.isPunct('(') ? [] : this.parseArgs(nameTok);
    const node: Node = { k: 'call', name, args, start: nameTok.start, end: this.toks[this.i - 1].end };
    this.validateCall(node);
    return node;
  }

  private validateCall(node: Extract<Node, { k: 'call' }>): void {
    const a = node.args[0];
    const str = a?.k === 'string' ? a.v : undefined;
    const bad = (msg: string) => { throw this.err(msg, a ?? node); };
    switch (node.name) {
      case 'ObjectId':
        if (a && (str === undefined || !/^[0-9a-fA-F]{24}$/.test(str))) bad('ObjectId() needs a string of 24 hexadecimal characters.');
        break;
      case 'ISODate': case 'Date':
        if (str !== undefined && Number.isNaN(new Date(str).getTime())) bad(`"${str}" is not a valid date.`);
        break;
      case 'NumberLong': case 'Long':
        if (a && str !== undefined && !/^-?\d+$/.test(str)) bad('NumberLong() needs an integer.');
        break;
      case 'NumberDecimal': case 'Decimal128':
        if (a && str !== undefined && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(NaN|Infinity)$/.test(str)) bad('Decimal128() needs a number in a string, such as "19.99".');
        break;
      case 'UUID':
        if (a && (str === undefined || !/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(str))) bad('UUID() needs a string such as "00112233-4455-6677-8899-aabbccddeeff".');
        break;
      case 'BinData':
        if (node.args.length !== 2 || node.args[0].k !== 'number' || node.args[1].k !== 'string') bad('BinData() needs a subtype and a base64 string: BinData(0, "aGVsbG8=").');
        break;
      case 'HexData':
        if (node.args.length !== 2 || node.args[0].k !== 'number' || node.args[1].k !== 'string') bad('HexData() needs a subtype and a hex string: HexData(0, "ff00").');
        break;
    }
  }

  private parseObject(open: Token): Node {
    const entries: { key: string; keyLoc: Loc; value: Node }[] = [];
    for (;;) {
      if (this.isPunct('}')) {
        const close = this.next()!;
        return { k: 'object', entries, start: open.start, end: close.end };
      }
      const keyTok = this.next();
      if (!keyTok) throw this.err(`Expected '}': the object that starts at position ${open.start + 1} is not closed.`);
      let key: string;
      if (keyTok.type === 'string') key = unescapeString(keyTok.text);
      else if (keyTok.type === 'ident' || keyTok.type === 'number') key = keyTok.text;
      else if (keyTok.type === 'error' && keyTok.text[0] !== '/') throw this.err('This key is missing its closing quote.', keyTok);
      else throw this.err(`Expected a field name but found ${this.describe(keyTok)}.`, keyTok);
      if (!this.isPunct(':')) {
        throw this.err(`Expected ':' after the field name "${key}" but found ${this.describe(this.peek())}.`, this.peek() ?? keyTok);
      }
      this.next();
      const value = this.parseExpr();
      entries.push({ key, keyLoc: { start: keyTok.start, end: keyTok.end }, value });
      if (this.isPunct(',')) { this.next(); continue; }
      if (this.isPunct('}')) continue;
      const found = this.peek();
      if (!found) throw this.err(`Expected ',' or '}': the object that starts at position ${open.start + 1} is not closed.`);
      throw this.err(`Expected ',' or '}' but found ${this.describe(found)}.`, found);
    }
  }

  private parseArray(open: Token): Node {
    const items: Node[] = [];
    for (;;) {
      if (this.isPunct(']')) {
        const close = this.next()!;
        return { k: 'array', items, start: open.start, end: close.end };
      }
      if (!this.peek()) throw this.err(`Expected ']': the array that starts at position ${open.start + 1} is not closed.`);
      items.push(this.parseExpr());
      if (this.isPunct(',')) { this.next(); continue; }
      if (this.isPunct(']')) continue;
      const found = this.peek();
      if (!found) throw this.err(`Expected ',' or ']': the array that starts at position ${open.start + 1} is not closed.`);
      throw this.err(`Expected ',' or ']' but found ${this.describe(found)}.`, found);
    }
  }
}

/** Parses any shell literal. Throws ShellSyntaxError with position information. */
export function parseShell(src: string): Node {
  return new Parser(src).parseAll();
}

/**
 * Parses text expected to hold a document, e.g. a query filter. Returns null for
 * blank input and accepts missing outer braces (`status: "active"`).
 */
export function parseDocumentText(src: string): Extract<Node, { k: 'object' }> | null {
  if (!tokenize(src).some((t) => t.type !== 'comment')) return null;
  let node: Node;
  try {
    node = parseShell(src);
  } catch (err) {
    const first = tokenize(src).filter((t) => t.type !== 'comment');
    const looksLikeBareFields = first.length > 1 && first[0].text !== '{' && first[1].text === ':';
    if (!looksLikeBareFields) throw err;
    try {
      node = parseShell(`{${src}\n}`);
    } catch {
      throw err;
    }
  }
  if (node.k !== 'object') throw new ShellSyntaxError('This must be a document in { curly braces }.', node.start, node.end, src);
  return node;
}

/** Parses text expected to hold an array of documents (an aggregation pipeline). */
export function parseArrayText(src: string): Extract<Node, { k: 'array' }> | null {
  if (!tokenize(src).some((t) => t.type !== 'comment')) return null;
  const node = parseShell(src);
  if (node.k !== 'array') throw new ShellSyntaxError('This must be an array in [ square brackets ].', node.start, node.end, src);
  return node;
}

/** Returns an error for invalid query text, or null when it is valid or blank. */
export function validateDocumentText(src: string): ShellSyntaxError | null {
  try {
    parseDocumentText(src);
    return null;
  } catch (err) {
    if (err instanceof ShellSyntaxError) return err;
    throw err;
  }
}
