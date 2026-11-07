import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { client, getState, onEvent, patchState, RpcFailure } from './rpc';
import { Button, Dialog, formatCompact, formatNumber, Icon, IconButton, MenuHost, newRequestId, openMenu, type MenuItem } from './ui';
import { CodeInput, type FieldSuggestion } from './CodeInput';
import { columnsOf, DocsView, ViewSwitch, type DocActions, type ViewMode } from './DocViews';
import { AggregationTab, ExplainPanel, IndexesTab, SchemaTab, StatsTab } from './Tabs';
import { collectPaths, scalarToShell, wireToShell, type Wire, type WireDoc } from '../shared/wire';
import { parseDocumentText, validateDocumentText } from '../shared/shell';
import type {
  AiResult, CollectionApi, CollectionEvent, CollectionInit, CollectionTab, CountResult, ExplainSummary, FindResult, QueryInput, RpcError, SavedQuery,
} from '../shared/protocol';

export const api = client<CollectionApi>();

interface Persisted {
  ref: { connectionId: string; database: string; collection: string; type: string };
  query: QueryInput;
  view: ViewMode;
  hidden: string[];
  tab: CollectionTab;
  optionsOpen: boolean;
}

const EMPTY: QueryInput = { filter: '', sort: '', project: '', limit: '' };

/** Reads a sort spec's fields for the table header. Blank or invalid text gives none. */
function sortMap(text: string): Record<string, number> {
  try {
    const node = parseDocumentText(text);
    const out: Record<string, number> = {};
    node?.entries.forEach((e) => { if (e.value.k === 'number') out[e.key] = e.value.v; });
    return out;
  } catch {
    return {};
  }
}

const sortText = (m: Record<string, number>) => {
  const parts = Object.entries(m).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${v}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '';
};

/** Lets people paste a bare id into the filter box to search by _id. */
function normalizeFilter(text: string): string {
  const m = text.trim().match(/^["']?([0-9a-fA-F]{24})["']?$/);
  return m ? `{ _id: ObjectId("${m[1]}") }` : text;
}

function localError(text: string, field: string): string | null {
  const err = validateDocumentText(text);
  if (!err) return null;
  const where = text.includes('\n') ? ` (line ${err.line})` : '';
  return `${field}: ${err.message}${where}`;
}

const ENV_LABEL: Record<string, string> = { production: 'PRODUCTION', staging: 'Staging', development: 'Dev', local: 'Local' };

export function CollectionApp() {
  const [init, setInit] = useState<CollectionInit | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  useEffect(() => {
    api('init').then(setInit).catch((e: Error) => setInitError(e.message));
  }, []);
  if (initError) return <div class="center-message"><Icon name="error" /> {initError}</div>;
  if (!init) return <div class="center-message"><Icon name="loading" spin /> Loading…</div>;
  return (
    <>
      <Viewer init={init} />
      <MenuHost />
    </>
  );
}

function Viewer({ init }: { init: CollectionInit }) {
  const saved = useMemo(() => getState<Persisted>(), []);
  const [tab, setTab] = useState<CollectionTab>(init.restored ? saved.tab ?? 'documents' : init.tab);
  const [query, setQuery] = useState<QueryInput>(saved.query ?? EMPTY);
  const [optionsOpen, setOptionsOpen] = useState(saved.optionsOpen ?? !!(saved.query?.sort || saved.query?.project || saved.query?.limit));
  const [view, setView] = useState<ViewMode>(saved.view ?? init.defaultView);
  const [hidden, setHidden] = useState<Set<string>>(new Set(saved.hidden ?? []));
  const [pageSize, setPageSize] = useState(init.pageSize);
  const [result, setResult] = useState<FindResult | null>(null);
  const [applied, setApplied] = useState<QueryInput | null>(null);
  const [count, setCount] = useState<CountResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<RpcError | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [fields, setFields] = useState<FieldSuggestion[]>([]);
  const [explain, setExplain] = useState<ExplainSummary | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const running = useRef<string | null>(null);
  const fieldsRequested = useRef(false);
  const lastAnchor = useRef<number | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    patchState({
      ref: { connectionId: init.connectionId, database: init.database, collection: init.collection, type: init.collectionType },
      query, view, hidden: [...hidden], tab, optionsOpen,
    });
  }, [query, view, hidden, tab, optionsOpen]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  const filterError = localError(query.filter.trim().match(/^["']?[0-9a-fA-F]{24}["']?$/) ? '' : query.filter, 'Filter');
  const sortError = localError(query.sort, 'Sort');
  const projectError = localError(query.project, 'Project');
  const limitError = query.limit.trim() && !/^\d+$/.test(query.limit.trim()) ? 'Limit: must be a whole number.' : null;
  const inputError = filterError ?? sortError ?? projectError ?? limitError;

  const run = useCallback(async (q: QueryInput, page: number, size: number, opts: { record?: boolean; keepCount?: boolean } = {}) => {
    const requestId = newRequestId();
    if (running.current) void api('cancel', { requestId: running.current });
    running.current = requestId;
    setLoading(true);
    setSlow(false);
    setError(null);
    setExplain(null);
    const slowTimer = window.setTimeout(() => setSlow(true), 400);
    const normalized = { ...q, filter: normalizeFilter(q.filter) };
    try {
      const res = await api('find', { ...normalized, requestId, page, pageSize: size });
      if (running.current !== requestId) return;
      setResult(res);
      setApplied(normalized);
      setCursor(-1);
      setSelected(new Set());
      if (normalized.filter !== q.filter) setQuery(normalized);
      if (opts.record && (q.filter || q.sort || q.project || q.limit)) void api('recordHistory', normalized);
      if (!opts.keepCount) {
        setCount(null);
        api('count', { filter: normalized.filter })
          .then((c) => { if (running.current === requestId || !running.current) setCount(c); })
          .catch(() => setCount({ count: null, exact: false }));
      }
      const paths = new Set<string>();
      res.docs.slice(0, 20).forEach((d) => collectPaths(d.value, '', paths));
      setFields((prev) => {
        const known = new Set(prev.map((f) => f.path));
        const added = [...paths].filter((p) => !known.has(p)).map((path) => ({ path }));
        return added.length ? [...prev, ...added] : prev;
      });
    } catch (e) {
      if (running.current !== requestId) return;
      const err = e as RpcFailure;
      if (!err.cancelled) setError(err);
      else setError({ message: 'Query cancelled.' });
    } finally {
      window.clearTimeout(slowTimer);
      if (running.current === requestId) {
        running.current = null;
        setLoading(false);
        setSlow(false);
      }
    }
  }, []);

  const execute = useCallback(() => {
    setQuery((q) => {
      void run(q, 0, pageSize, { record: true });
      return q;
    });
  }, [run, pageSize]);

  const refresh = useCallback(() => {
    if (applied) void run(applied, result?.page ?? 0, pageSize);
    else void run(query, 0, pageSize);
  }, [applied, result, pageSize, query, run]);

  const firstRun = useRef(false);
  useEffect(() => {
    if (firstRun.current || tab !== 'documents') return;
    firstRun.current = true;
    // A restored panel with a custom query waits for the user. Nothing runs by itself.
    if (init.restored && (query.filter || query.sort || query.project || query.limit)) return;
    void run(query, 0, pageSize);
  }, [tab]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => onEvent<CollectionEvent>((event) => {
    if (event.name === 'refresh') refreshRef.current();
    else if (event.name === 'setTab') setTab(event.tab);
  }), []);

  const needFields = useCallback(() => {
    if (fieldsRequested.current) return;
    fieldsRequested.current = true;
    api('suggestFields').then((list) => {
      setFields((prev) => {
        const typed = new Map(list.map((f) => [f.path, f.type]));
        const merged: FieldSuggestion[] = list.map((f) => ({ path: f.path, type: f.type }));
        prev.forEach((p) => { if (!typed.has(p.path)) merged.push(p); });
        return merged;
      });
    }).catch(() => undefined);
  }, []);

  const update = (patch: Partial<QueryInput>) => setQuery((q) => ({ ...q, ...patch }));
  const docs = result?.docs ?? [];

  const onSort = (field: string, additive: boolean) => {
    const current = sortMap(query.sort);
    const dir = current[field];
    const next: Record<string, number> = additive ? { ...current } : {};
    if (dir === undefined) next[field] = 1;
    else if (dir > 0) next[field] = -1;
    else delete next[field];
    const q = { ...query, sort: sortText(next) };
    setQuery(q);
    if (q.sort) setOptionsOpen(true);
    void run(q, 0, pageSize, { keepCount: true });
  };

  const toggleSelect = (id: string, range: boolean) => {
    const idx = docs.findIndex((d) => d.id === id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && lastAnchor.current !== null) {
        const [a, b] = [Math.min(lastAnchor.current, idx), Math.max(lastAnchor.current, idx)];
        for (let i = a; i <= b; i++) { const d = docs[i].id; if (d) next.add(d); }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastAnchor.current = idx;
  };

  const filterByValue = (path: string[], value: Wire) => {
    const key = path.filter((p) => !/^\d+$/.test(p)).join('.');
    const lit = scalarToShell(value) ?? '';
    const keyText = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    let filter = `{ ${keyText}: ${lit} }`;
    const current = query.filter.trim();
    if (current && !validateDocumentText(current)) {
      const inner = current.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
      if (inner) filter = `{ ${inner}, ${keyText}: ${lit} }`;
    }
    const q = { ...query, filter };
    setQuery(q);
    void run(q, 0, pageSize, { record: true });
  };

  const reportError = (e: unknown) => {
    const err = e as RpcFailure;
    if (err.cancelled || err.message === 'Cancelled') return;
    setError(err);
  };

  const actions: DocActions = {
    onCopy: (text, label) => { void api('copyText', { text, label }); showToast(`Copied ${label ?? ''}`.trim()); },
    onOpen: init.collectionType === 'view' && !init.canWrite
      ? (doc) => { if (doc.id) void api('openDocument', { id: doc.id }).catch(reportError); }
      : (doc) => {
        if (doc.id) void api('openDocument', { id: doc.id }).catch(reportError);
        else showToast('This result has no _id, so it cannot be opened. Remove the _id: 0 projection.');
      },
    onFilterBy: filterByValue,
    ...(init.canWrite ? {
      onDuplicate: (doc: WireDoc) => { if (doc.id) void api('duplicateDocument', { id: doc.id }).catch(reportError); },
      onDelete: (doc: WireDoc) => {
        if (doc.id) void api('deleteDocuments', { ids: [doc.id] }).then((n) => { if (n) showToast('Document deleted'); }).catch(reportError);
      },
      onEditField: (doc: WireDoc, path: string[], value: Wire) => {
        if (doc.id) setDialog({ kind: 'editField', doc, path, text: wireToShell(value, true) });
      },
      onAddField: (doc: WireDoc, parent: string[]) => {
        if (doc.id) setDialog({ kind: 'addField', doc, parent, name: '', text: '' });
      },
      onRemoveField: (doc: WireDoc, path: string[]) => {
        if (doc.id) void api('removeField', { id: doc.id, path }).then((ok) => { if (ok) showToast('Field removed'); }).catch(reportError);
      },
    } : {}),
  };

  // Keyboard shortcuts when focus isn't in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (tab !== 'documents' || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || dialog || target.closest('.menu')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const canNext = result?.hasMore;
      const page = result?.page ?? 0;
      switch (e.key) {
        case '/': e.preventDefault(); filterRef.current?.querySelector('textarea')?.focus(); break;
        case 'r': refresh(); break;
        case '1': setView('table'); break;
        case '2': setView('json'); break;
        case '3': setView('tree'); break;
        case 'n': case ']': if (canNext && applied) void run(applied, page + 1, pageSize, { keepCount: true }); break;
        case 'p': case '[': if (page > 0 && applied) void run(applied, page - 1, pageSize, { keepCount: true }); break;
        case 'ArrowDown': case 'j': e.preventDefault(); setCursor((c) => Math.min(c + 1, docs.length - 1)); break;
        case 'ArrowUp': case 'k': e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); break;
        case 'Enter': if (docs[cursor]) actions.onOpen?.(docs[cursor]); break;
        case ' ': if (docs[cursor]?.id && init.canWrite) { e.preventDefault(); toggleSelect(docs[cursor].id!, false); } break;
        case 'Delete': case 'Backspace':
          if (docs[cursor] && actions.onDelete) actions.onDelete(docs[cursor]);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    document.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const doExplain = async () => {
    if (inputError) return;
    setExplaining(true);
    setError(null);
    try {
      setExplain(await api('explain', { ...query, filter: normalizeFilter(query.filter), requestId: newRequestId() }));
    } catch (e) {
      reportError(e);
    } finally {
      setExplaining(false);
    }
  };

  const applyQuery = (q: QueryInput) => {
    const next = { filter: q.filter, sort: q.sort, project: q.project, limit: q.limit };
    setQuery(next);
    if (next.sort || next.project || next.limit) setOptionsOpen(true);
    void run(next, 0, pageSize, { record: true });
  };

  const openHistory = async (e: MouseEvent) => {
    const anchor = { currentTarget: e.currentTarget, clientX: e.clientX, clientY: e.clientY, type: 'click', preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent;
    const { history, saved: savedList } = await api('history');
    const label = (s: SavedQuery) => [s.filter || '{}', s.sort && `sort ${s.sort}`, s.project && `project ${s.project}`, s.limit && `limit ${s.limit}`].filter(Boolean).join('  ·  ');
    const items: MenuItem[] = [];
    if (savedList.length) {
      items.push({ label: 'Saved', disabled: true, icon: 'star-full' });
      savedList.forEach((s) => items.push({ label: s.name, hint: label(s).slice(0, 40), onSelect: () => applyQuery(s) }));
      items.push({ separator: true }, ...savedList.map((s): MenuItem => ({ label: `Delete "${s.name}"`, icon: 'trash', onSelect: () => void api('deleteSaved', { id: s.id }) })), { separator: true });
    }
    items.push({ label: 'Recent', disabled: true, icon: 'history' });
    if (!history.length) items.push({ label: 'No queries yet', disabled: true });
    history.slice(0, 15).forEach((s) => items.push({ label: label(s).slice(0, 90), onSelect: () => applyQuery(s) }));
    openMenu(anchor, items);
  };

  const allColumns = useMemo(() => columnsOf(docs), [docs]);
  const columnMenu = (e: MouseEvent) => {
    const items: MenuItem[] = allColumns.map((c) => ({
      label: c,
      icon: hidden.has(c) ? undefined : 'check',
      onSelect: () => setHidden((h) => {
        const n = new Set(h);
        if (n.has(c)) n.delete(c);
        else n.add(c);
        return n;
      }),
    }));
    if (hidden.size) items.push({ separator: true }, { label: 'Show All Columns', onSelect: () => setHidden(new Set()) });
    openMenu(e, items);
  };

  const currentQuery = applied ?? query;
  const exportMenu = (e: MouseEvent) => {
    const page = result?.page ?? 0;
    const scoped = (scopeLabel: string, scope: Parameters<typeof api<'exportDocs'>>[1]['scope']): MenuItem[] => [
      { label: `${scopeLabel} as JSON`, icon: 'json', onSelect: () => void api('exportDocs', { scope, format: 'json' }).catch(reportError) },
      { label: `${scopeLabel} as CSV`, icon: 'table', onSelect: () => void api('exportDocs', { scope, format: 'csv' }).catch(reportError) },
    ];
    openMenu(e, [
      ...(selected.size ? [...scoped(`Export ${selected.size} Selected`, { kind: 'selected', ids: [...selected] }), { separator: true }] : []),
      ...scoped('Export This Page', { kind: 'page', query: currentQuery, page, pageSize }),
      { separator: true },
      ...scoped('Export All Results', { kind: 'query', query: currentQuery }),
      { separator: true },
      { label: 'Copy This Page as JSON', icon: 'copy', onSelect: () => actions.onCopy(`[\n${docs.map((d) => wireToShell(d.value)).join(',\n')}\n]`, `${docs.length} documents`) },
    ]);
  };

  const page = result?.page ?? 0;
  const rangeStart = docs.length ? page * pageSize + 1 : 0;
  const rangeEnd = page * pageSize + docs.length;
  const envLabel = ENV_LABEL[init.environment];
  const isProd = init.environment === 'production';

  return (
    <div class={`app${isProd ? ' env-production' : ''}`}>
      <header class="topbar">
        <div class="crumbs" title={init.hostLabel}>
          {envLabel && <span class={`env-badge env-${init.environment}`}>{envLabel}</span>}
          <span class="crumb">{init.connectionName}</span>
          <Icon name="chevron-right" />
          <span class="crumb">{init.database}</span>
          <Icon name="chevron-right" />
          <span class="crumb current">{init.collection}</span>
          {init.collectionType !== 'collection' && <span class="tag">{init.collectionType}</span>}
          {init.readOnly && <span class="tag" title="Writes are blocked on this connection"><Icon name="lock" /> read-only</span>}
        </div>
        <nav class="tabs" role="tablist">
          {([['documents', 'Documents'], ['aggregation', 'Aggregation'], ['schema', 'Schema'], ['indexes', 'Indexes'], ['stats', 'Stats']] as [CollectionTab, string][]).map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} class={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{label}</button>
          ))}
        </nav>
        <div class="topbar-tools">
          <IconButton icon="terminal" title="Open mongosh" onClick={() => void api('openShell').catch(reportError)} />
        </div>
      </header>

      <div class={tab === 'documents' ? 'tab-body' : 'tab-body hidden'}>
        <section class="querybar" aria-label="Query">
          {aiOpen && init.aiEnabled && (
            <AiBar
              model={init.aiModel}
              onClose={() => setAiOpen(false)}
              onResult={(r) => {
                const q = { filter: r.filter, sort: r.sort, project: r.project, limit: r.limit };
                setQuery(q);
                if (q.sort || q.project || q.limit) setOptionsOpen(true);
                if (r.autoRun) void run(q, 0, pageSize, { record: true });
                else filterRef.current?.querySelector('textarea')?.focus();
              }}
            />
          )}
          <div class="query-row">
            {init.aiEnabled && <IconButton icon="sparkle" title="Describe what you're looking for in plain language" active={aiOpen} onClick={() => setAiOpen(!aiOpen)} />}
            <span class="field-label">Filter</span>
            <div class="grow" ref={filterRef}>
              <CodeInput
                label="Filter"
                value={query.filter}
                onChange={(filter) => update({ filter })}
                onSubmit={execute}
                placeholder='{ status: "active", age: { $gte: 18 } } or paste an _id'
                mode="filter"
                fields={fields}
                onNeedFields={needFields}
                invalid={!!filterError}
              />
            </div>
            {loading && slow
              ? <Button onClick={() => { if (running.current) void api('cancel', { requestId: running.current }); }} title="Cancel this query"><Icon name="debug-stop" /> Cancel</Button>
              : <Button primary onClick={execute} disabled={!!inputError} title="Run query (Enter)"><Icon name="play" /> Run</Button>}
            <IconButton icon="clear-all" title="Reset query" onClick={() => applyQuery(EMPTY)} disabled={!query.filter && !query.sort && !query.project && !query.limit} />
            <IconButton icon="history" title="Recent and saved queries" onClick={openHistory} />
            <IconButton icon="star-empty" title="Save this query" onClick={() => void api('saveQuery', query).then((s) => { if (s) showToast(`Saved "${s.name}"`); })} disabled={!query.filter && !query.sort && !query.project} />
            <IconButton icon={optionsOpen ? 'chevron-up' : 'settings'} title="Sort, project and limit" active={optionsOpen || !!(query.sort || query.project || query.limit)} onClick={() => setOptionsOpen(!optionsOpen)} />
          </div>
          {optionsOpen && (
            <div class="query-row options">
              <span class="field-label">Sort</span>
              <div class="grow"><CodeInput label="Sort" value={query.sort} onChange={(sort) => update({ sort })} onSubmit={execute} placeholder="{ createdAt: -1 }" mode="sort" fields={fields} onNeedFields={needFields} invalid={!!sortError} /></div>
              <span class="field-label">Project</span>
              <div class="grow"><CodeInput label="Project" value={query.project} onChange={(project) => update({ project })} onSubmit={execute} placeholder="{ name: 1, email: 1, _id: 0 }" mode="project" fields={fields} onNeedFields={needFields} invalid={!!projectError} /></div>
              <span class="field-label">Limit</span>
              <input
                class={`input limit${limitError ? ' invalid' : ''}`}
                aria-label="Limit"
                inputMode="numeric"
                placeholder="None"
                value={query.limit}
                onInput={(e) => update({ limit: e.currentTarget.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') execute(); }}
              />
            </div>
          )}
          {inputError && <div class="query-error" role="alert"><Icon name="error" /> {inputError}</div>}
        </section>

        <div class="toolbar">
          <ViewSwitch view={view} onChange={setView} />
          {view === 'table' && <IconButton icon="eye" title="Choose columns" onClick={columnMenu} disabled={!allColumns.length} />}
          <span class="toolbar-sep" />
          {init.canWrite && <IconButton icon="add" label="Insert" title="Insert a document" onClick={() => void api('insertDocument').catch(reportError)} />}
          {init.canWrite && <IconButton icon="cloud-upload" title="Import documents from a JSON file" onClick={() => void api('importDocs').catch(reportError)} />}
          <IconButton icon="cloud-download" title="Export or copy results" onClick={exportMenu} />
          <IconButton icon="dashboard" title="Explain this query" onClick={() => void doExplain()} disabled={explaining || !!inputError} />
          <IconButton icon="notebook" title="Open this query in a playground" onClick={() => void api('toPlayground', currentQuery).catch(reportError)} />
          {selected.size > 0 && (
            <div class="selection" role="status">
              <span>{selected.size} selected</span>
              <IconButton icon="edit" title="Update selected documents" onClick={() => void api('promptBulkUpdate', { scope: { ids: [...selected] }, count: selected.size }).then((n) => { if (n) showToast(`Updated ${n} documents`); }).catch(reportError)} />
              <IconButton icon="trash" title="Delete selected documents" danger onClick={() => void api('deleteDocuments', { ids: [...selected] }).then((n) => { if (n) showToast(`Deleted ${n} documents`); }).catch(reportError)} />
              <IconButton icon="close" title="Clear selection" onClick={() => setSelected(new Set())} />
            </div>
          )}
          <div class="grow" />
          <span class="exec-stats" role="status">
            {result && !loading && `${formatNumber(docs.length)} doc${docs.length === 1 ? '' : 's'} · ${result.ms} ms`}
          </span>
          <IconButton icon="refresh" title="Refresh results (r)" onClick={refresh} />
          <label class="page-size">
            <span class="sr-only">Page size</span>
            <select
              class="select"
              value={pageSize}
              onChange={(e) => {
                const size = Number(e.currentTarget.value);
                setPageSize(size);
                void api('setPageSize', { pageSize: size });
                void run(applied ?? query, 0, size, { keepCount: true });
              }}
            >
              {[20, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
          </label>
          <span class="page-range" title={count && !count.exact ? 'Estimated total from collection metadata' : undefined}>
            {rangeStart}–{rangeEnd}
            {count?.count !== null && count?.count !== undefined && <> of {count.exact ? '' : '~'}{formatCompact(count.count)}</>}
            {count?.timedOut && ' of many'}
          </span>
          <IconButton icon="chevron-left" title="Previous page (p)" disabled={page === 0 || loading} onClick={() => applied && void run(applied, page - 1, pageSize, { keepCount: true })} />
          <IconButton icon="chevron-right" title="Next page (n)" disabled={!result?.hasMore || loading} onClick={() => applied && void run(applied, page + 1, pageSize, { keepCount: true })} />
        </div>

        {loading && <div class="progress" role="progressbar" aria-label="Running query" />}
        {error && (
          <div class="banner error" role="alert">
            <Icon name="error" />
            <span class="grow">{error.field ? `${error.field[0].toUpperCase()}${error.field.slice(1)}: ` : ''}{error.message}</span>
            <IconButton icon="close" title="Dismiss" onClick={() => setError(null)} />
          </div>
        )}
        {explain && <ExplainPanel explain={explain} canCreate={init.canWrite} onClose={() => setExplain(null)} onCopy={actions.onCopy} onChanged={() => void doExplain()} />}

        <main class="results">
          {docs.length > 0 ? (
            <DocsView
              view={view}
              docs={docs}
              actions={actions}
              hiddenColumns={hidden}
              sort={sortMap(query.sort)}
              onSort={onSort}
              selected={init.canWrite || selected.size ? selected : undefined}
              onToggleSelect={init.canWrite ? toggleSelect : undefined}
              onToggleAll={() => setSelected((s) => (docs.every((d) => d.id && s.has(d.id)) ? new Set() : new Set(docs.map((d) => d.id).filter((x): x is string => !!x))))}
              cursor={cursor}
              onCursor={setCursor}
            />
          ) : !loading && result ? (
            <div class="center-message">
              <Icon name="search" />
              <div>{applied && (applied.filter || applied.limit) ? 'No documents match this query.' : 'This collection is empty.'}</div>
              {init.canWrite && !(applied?.filter) && <Button onClick={() => void api('insertDocument').catch(reportError)}>Insert a document</Button>}
            </div>
          ) : !loading && !result && !error ? (
            <div class="center-message"><div>Press Run to execute this query.</div></div>
          ) : null}
        </main>
      </div>

      {tab === 'aggregation' && <AggregationTab init={init} fields={fields} needFields={needFields} onCopy={actions.onCopy} />}
      {tab === 'schema' && <SchemaTab onFilter={(path) => { update({ filter: `{ ${/^[A-Za-z_$][\w$]*$/.test(path) ? path : JSON.stringify(path)}: { $exists: true } }` }); setTab('documents'); }} />}
      {tab === 'indexes' && <IndexesTab init={init} fields={fields} needFields={needFields} onCopy={actions.onCopy} />}
      {tab === 'stats' && <StatsTab />}

      {dialog && (
        <FieldDialog
          state={dialog}
          fields={fields}
          onClose={() => setDialog(null)}
          onSaved={(msg) => { setDialog(null); showToast(msg); }}
        />
      )}
      {toast && <div class="toast" role="status"><Icon name="check" /> {toast}</div>}
    </div>
  );
}

type DialogState =
  | { kind: 'editField'; doc: WireDoc; path: string[]; text: string }
  | { kind: 'addField'; doc: WireDoc; parent: string[]; name: string; text: string };

function FieldDialog({ state, onClose, onSaved }: { state: DialogState; fields: FieldSuggestion[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [text, setText] = useState(state.text);
  const [name, setName] = useState(state.kind === 'addField' ? state.name : '');
  const [error, setError] = useState<string | null>(null);
  const isAdd = state.kind === 'addField';

  const submit = async () => {
    const path = state.kind === 'addField' ? [...state.parent, ...name.trim().split('.')] : state.path;
    if (isAdd && !name.trim()) {
      setError('Enter a field name.');
      return;
    }
    if (!text.trim()) {
      setError('Enter a value. Strings need quotes: "text".');
      return;
    }
    try {
      await api('updateField', { id: state.doc.id!, path, value: text });
      onSaved(isAdd ? 'Field added' : 'Field updated');
    } catch (e) {
      const err = e as RpcFailure;
      if (err.message !== 'Cancelled') setError(err.message);
    }
  };

  return (
    <Dialog title={isAdd ? 'Add Field' : `Edit ${state.kind === 'editField' ? state.path.join('.') : ''}`} onClose={onClose} width={520}>
      {isAdd && (
        <label class="form-field">
          <span>Field name</span>
          <input class="input" value={name} placeholder="address.city" onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </label>
      )}
      <label class="form-field">
        <span>Value</span>
        <CodeInput value={text} onChange={setText} onSubmit={() => void submit()} mode="value" minRows={2} label="Value" invalid={!!error} placeholder='"text", 42, true, ISODate("2024-01-01"), Decimal128("9.99")' />
      </label>
      <div class="hint">Types are kept exactly as written: 5 is an Int32, 5.0 is a Double, and NumberLong("5") is a Long.</div>
      {error && <div class="query-error" role="alert"><Icon name="error" /> {error}</div>}
      <div class="dialog-buttons">
        <Button onClick={onClose}>Cancel</Button>
        <Button primary onClick={() => void submit()}>Save</Button>
      </div>
    </Dialog>
  );
}

function AiBar({ model: initialModel, onResult, onClose }: { model: string; onResult: (r: AiResult) => void; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [model, setModel] = useState(initialModel);
  const requestId = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => onEvent<CollectionEvent>((event) => {
    if (event.name === 'aiProgress' && event.requestId === requestId.current) setStatus(event.status);
  }), []);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    const id = newRequestId();
    requestId.current = id;
    setBusy(true);
    setNote(null);
    setStatus('Starting…');
    try {
      const r = await api('ai', { prompt, requestId: id });
      onResult(r);
      setModel(r.model);
      setNote({ text: `${r.explanation || 'Query ready.'} ${r.autoRun ? '' : 'Press Enter to run it.'} (${(r.ms / 1000).toFixed(1)} s)` });
    } catch (e) {
      const err = e as RpcFailure;
      if (!err.cancelled) setNote({ text: err.message, error: true });
    } finally {
      setBusy(false);
      requestId.current = null;
    }
  };

  return (
    <div class="ai-bar">
      <div class="query-row">
        <Icon name="sparkle" />
        <input
          ref={inputRef}
          class="input grow"
          aria-label="Describe your query"
          placeholder="Describe what you're looking for: active users in Paris, newest first"
          value={prompt}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') onClose();
          }}
        />
        <button
          type="button"
          class="model-chip"
          title="Choose AI model"
          onClick={() => void api('chooseAiModel').then(setModel)}
        >
          <Icon name="chip" /> {model}
        </button>
        {busy
          ? <Button onClick={() => { if (requestId.current) void api('cancel', { requestId: requestId.current }); }}><Icon name="debug-stop" /> Stop</Button>
          : <Button onClick={() => void submit()} disabled={!prompt.trim()}>Generate</Button>}
        <IconButton icon="close" title="Close" onClick={onClose} />
      </div>
      {busy && <div class="ai-note"><Icon name="loading" spin /> {status}</div>}
      {note && <div class={`ai-note${note.error ? ' error' : ''}`} role="status">{note.error && <Icon name="error" />} {note.text}</div>}
    </div>
  );
}
