// A small syntax-highlighted input with field and operator autocomplete. It's a
// transparent textarea over a highlighted layer, far lighter than embedding Monaco.
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { highlight, tokenize } from '../shared/shell';
import { QUERY_OPERATORS, UPDATE_OPERATORS, VALUE_HELPERS } from '../shared/operators';

export interface FieldSuggestion { path: string; type?: string }

export type CompletionMode = 'filter' | 'sort' | 'project' | 'value' | 'keys' | 'update' | 'stage';

interface Suggestion {
  label: string;
  detail?: string;
  insert: string;
  /** Caret position measured back from the end of the inserted text. */
  caretBack?: number;
}

interface CompletionState { items: Suggestion[]; start: number; end: number }

const QUOTE = /["'`]/;
const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '"': '"', "'": "'", '`': '`' };
const CLOSERS = new Set(['}', ']', ')', '"', "'", '`']);

const keyText = (path: string) => (/^[A-Za-z_$][\w$]*$/.test(path) ? path : JSON.stringify(path));

function computeCompletions(text: string, cursor: number, mode: CompletionMode, fields: FieldSuggestion[], explicit: boolean): CompletionState | null {
  const before = text.slice(0, cursor);
  const partialMatch = before.match(/[\w$.]*$/);
  const partial = partialMatch ? partialMatch[0] : '';
  const start = cursor - partial.length;
  const toks = tokenize(before.slice(0, start));
  const lastTok = toks[toks.length - 1];
  if (lastTok && (lastTok.type === 'comment' || (lastTok.type === 'error' && QUOTE.test(lastTok.text[0])))) return null;
  const sig = toks.filter((t) => t.type !== 'comment');
  const stack: string[] = [];
  for (const t of sig) {
    if (t.type !== 'punct') continue;
    if (t.text === '{' || t.text === '[' || t.text === '(') stack.push(t.text);
    else if (t.text === '}' || t.text === ']' || t.text === ')') stack.pop();
  }
  const top = stack[stack.length - 1];
  const prev = sig[sig.length - 1]?.text;
  const keyPos = (top === '{' && (prev === '{' || prev === ',')) || (!top && !prev && mode !== 'value' && mode !== 'stage');
  const valuePos = prev === ':' || top === '[' || top === '(' || (mode === 'value' && !top);
  const lower = partial.toLowerCase();
  if (!partial && !explicit) return null;
  const items: Suggestion[] = [];

  const matches = (label: string) => (lower ? label.toLowerCase().includes(lower) : true);
  const rank = (label: string) => (label.toLowerCase().startsWith(lower) ? 0 : 1);

  if (partial.startsWith('$') || (keyPos && !partial && (mode === 'filter' || mode === 'update'))) {
    const ops = mode === 'update' ? UPDATE_OPERATORS : mode === 'sort' || mode === 'project' || mode === 'keys' ? [] : QUERY_OPERATORS;
    for (const [op, detail] of ops) {
      if (matches(op)) items.push({ label: op, detail, insert: keyPos || prev !== ':' ? `${op}: ` : op });
    }
  }
  if (keyPos && !partial.startsWith('$')) {
    for (const f of fields) {
      if (matches(f.path)) items.unshift({ label: f.path, detail: f.type, insert: `${keyText(f.path)}: ` });
    }
  }
  if (valuePos && !partial.startsWith('$') && (partial || explicit)) {
    for (const [text2, detail] of VALUE_HELPERS) {
      if (matches(text2)) {
        const hasEmptyQuotes = text2.includes('""');
        items.push({ label: text2.replace('""', '…'), detail, insert: text2, caretBack: hasEmptyQuotes ? 2 : 0 });
      }
    }
  }
  if (!items.length) return null;
  if (items.length === 1 && items[0].insert.trim().replace(/:$/, '') === partial) return null;
  items.sort((a, b) => rank(a.label) - rank(b.label));
  return { items: items.slice(0, 40), start, end: cursor };
}

export interface CodeInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  mode?: CompletionMode;
  fields?: FieldSuggestion[];
  /** Called the first time autocomplete could use field names. */
  onNeedFields?: () => void;
  invalid?: boolean;
  label?: string;
  autoFocus?: boolean;
  minRows?: number;
  id?: string;
}

export function CodeInput(props: CodeInputProps) {
  const { value, onChange } = props;
  const ta = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [active, setActive] = useState(0);
  const navigated = useRef(false);
  const [focused, setFocused] = useState(false);
  const mode = props.mode ?? 'filter';

  const spans = useMemo(() => {
    const out: preact.ComponentChildren[] = [];
    let pos = 0;
    for (const h of highlight(value)) {
      if (h.start > pos) out.push(value.slice(pos, h.start));
      out.push(<span class={`tok-${h.cls}`}>{value.slice(h.start, h.end)}</span>);
      pos = h.end;
    }
    if (pos < value.length) out.push(value.slice(pos));
    return out;
  }, [value]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    if (pendingCaret.current !== null) {
      el.selectionStart = el.selectionEnd = pendingCaret.current;
      pendingCaret.current = null;
    }
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useLayoutEffect(() => {
    if (props.autoFocus) ta.current?.focus();
  }, []);

  const refresh = (text: string, cursor: number, explicit = false) => {
    props.onNeedFields?.();
    const next = computeCompletions(text, cursor, mode, props.fields ?? [], explicit);
    setCompletion(next);
    setActive(0);
    navigated.current = false;
  };

  const apply = (s: Suggestion) => {
    if (!completion) return;
    const after = value.slice(completion.end);
    const next = value.slice(0, completion.start) + s.insert + after;
    pendingCaret.current = completion.start + s.insert.length - (s.caretBack ?? 0);
    onChange(next);
    setCompletion(null);
  };

  const insertPair = (open: string, close: string, el: HTMLTextAreaElement) => {
    const { selectionStart: a, selectionEnd: b } = el;
    const selected = value.slice(a, b);
    onChange(value.slice(0, a) + open + selected + close + value.slice(b));
    pendingCaret.current = a + 1 + selected.length;
  };

  // Keys must keep bubbling: VS Code listens on the window to run its own shortcuts.
  const onKeyDown = (e: KeyboardEvent) => {
    const el = ta.current!;
    if (completion) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigated.current = true;
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setActive((active + d + completion.items.length) % completion.items.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && navigated.current && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        apply(completion.items[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCompletion(null);
        return;
      }
    }
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      refresh(value, el.selectionStart, true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      setCompletion(null);
      props.onSubmit?.();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const { selectionStart: a, selectionEnd: b } = el;
    if (PAIRS[e.key]) {
      const isQuote = QUOTE.test(e.key);
      const nextChar = value[a];
      if (isQuote && a === b && nextChar === e.key) {
        e.preventDefault();
        el.selectionStart = el.selectionEnd = a + 1;
        return;
      }
      const inWord = isQuote && a === b && /[\w\\]/.test(value[a - 1] ?? '');
      if (!inWord && (a !== b || !nextChar || /[\s,}\])]/.test(nextChar))) {
        e.preventDefault();
        insertPair(e.key, PAIRS[e.key], el);
        return;
      }
    }
    if (CLOSERS.has(e.key) && a === b && value[a] === e.key) {
      e.preventDefault();
      el.selectionStart = el.selectionEnd = a + 1;
      return;
    }
    if (e.key === 'Backspace' && a === b && a > 0 && PAIRS[value[a - 1]] === value[a] && value[a] !== undefined) {
      e.preventDefault();
      onChange(value.slice(0, a - 1) + value.slice(a + 1));
      pendingCaret.current = a - 1;
    }
  };

  return (
    <div class={`code-input${props.invalid ? ' invalid' : ''}${focused ? ' focused' : ''}`}>
      <pre class="code-layer" aria-hidden="true">
        {value ? spans : <span class="code-placeholder">{props.placeholder}</span>}
        {'\n'}
      </pre>
      <textarea
        ref={ta}
        id={props.id}
        rows={props.minRows ?? 1}
        spellcheck={false}
        autocapitalize="off"
        autocomplete="off"
        aria-label={props.label}
        aria-invalid={props.invalid}
        value={value}
        onInput={(e) => {
          const el = e.currentTarget;
          onChange(el.value);
          refresh(el.value, el.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => { setFocused(true); props.onNeedFields?.(); }}
        onBlur={() => { setFocused(false); setTimeout(() => setCompletion(null), 120); }}
      />
      {completion && focused && (
        <div class="completions" role="listbox">
          {completion.items.map((s, i) => (
            <div
              key={s.label}
              class={`completion${i === active ? ' active' : ''}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); apply(s); }}
              onMouseEnter={() => setActive(i)}
            >
              <span class="completion-label">{s.label}</span>
              {s.detail && <span class="completion-detail">{s.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
