import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from './CollectionApp';
import { Button, formatBytes, formatNumber, Icon, IconButton, newRequestId } from './ui';
import { CodeInput, type FieldSuggestion } from './CodeInput';
import { DocsView, ViewSwitch, type ViewMode } from './DocViews';
import { getState, patchState, type RpcFailure } from './rpc';
import { AGG_STAGES } from '../shared/operators';
import { tokenize, parseShell } from '../shared/shell';
import type {
  AggregateResult, AggregationStage, CollectionInit, CreateIndexInput, ExplainSummary, IndexInfo, PlanStage, SchemaField, SchemaResult, StatsResult,
} from '../shared/protocol';

// Schema -------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  String: 'var(--mv-string)', Int32: 'var(--mv-number)', Double: 'var(--mv-number)', Long: 'var(--mv-number)', Decimal128: 'var(--mv-number)',
  Boolean: 'var(--mv-bool)', Date: 'var(--mv-date)', ObjectId: 'var(--mv-oid)', Null: 'var(--mv-null)', Object: 'var(--mv-key)', Array: 'var(--mv-key)',
};

function SchemaRow({ f, depth, onFilter }: { f: SchemaField; depth: number; onFilter: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasChildren = f.children.length > 0;
  const total = f.types.reduce((n, t) => n + t.count, 0) || 1;
  const presencePct = Math.round(f.presence * 100);
  return (
    <>
      <tr class={hasChildren ? 'clickable' : ''} onClick={() => { if (hasChildren) setOpen(!open); }}>
        <td style={{ paddingLeft: `${depth * 16 + 8}px` }} class="schema-name">
          <span class="t-chevron">{hasChildren && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}</span>
          {f.name}
        </td>
        <td>
          <div class="type-list">
            {f.types.map((t) => (
              <span class="type-chip" key={t.type} title={`${formatNumber(t.count)} values`}>
                <i style={{ background: TYPE_COLORS[t.type] ?? 'var(--mv-special)' }} />
                {t.type === 'Array' && f.elementTypes?.length ? `Array<${f.elementTypes.map((e) => e.type).join(' | ')}>` : t.type}
                {f.types.length > 1 && <em>{Math.round((t.count / total) * 100)}%</em>}
              </span>
            ))}
          </div>
        </td>
        <td class="presence" title={`Present in ${formatNumber(f.count)} of the sampled documents at this level`}>
          <div class="meter"><div style={{ width: `${presencePct}%` }} class={presencePct < 100 ? 'partial' : ''} /></div>
          <span class={presencePct < 50 ? 'warn-text' : ''}>{f.presence > 0 && presencePct === 0 ? '<1' : presencePct}%</span>
        </td>
        <td class={f.nulls ? 'warn-text' : 'muted'}>{f.nulls ? formatNumber(f.nulls) : '—'}</td>
        <td class="samples" title={f.samples.join('\n')}>{f.samples.slice(0, 3).join('  ·  ')}</td>
        <td class="row-end">
          <IconButton icon="filter" title={`Find documents that have ${f.path}`} onClick={() => onFilter(f.path)} />
        </td>
      </tr>
      {open && f.children.map((c) => <SchemaRow key={c.path} f={c} depth={depth + 1} onFilter={onFilter} />)}
    </>
  );
}

export function SchemaTab({ onFilter }: { onFilter: (path: string) => void }) {
  const [res, setRes] = useState<SchemaResult | null>(null);
  const [size, setSize] = useState(500);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef<string | null>(null);
  const load = async (n: number) => {
    const id = newRequestId();
    req.current = id;
    setLoading(true);
    setError(null);
    try {
      setRes(await api('schema', { sampleSize: n, requestId: id }));
    } catch (e) {
      const err = e as RpcFailure;
      if (!err.cancelled) setError(err.message);
    } finally {
      setLoading(false);
      req.current = null;
    }
  };
  useEffect(() => { void load(size); }, []);
  return (
    <div class="tab-body scroll">
      <div class="toolbar">
        <span class="muted">{res ? `Sampled ${formatNumber(res.sampled)} random documents${res.ms !== undefined ? ` in ${res.ms} ms` : ''}` : 'Sampling…'}</span>
        <div class="grow" />
        <label class="inline-label">Sample
          <select class="select" value={size} onChange={(e) => { const n = Number(e.currentTarget.value); setSize(n); void load(n); }}>
            {[100, 500, 1000, 5000].map((n) => <option key={n} value={n}>{formatNumber(n)}</option>)}
          </select>
        </label>
        {loading
          ? <IconButton icon="debug-stop" title="Stop" onClick={() => { if (req.current) void api('cancel', { requestId: req.current }); }} />
          : <IconButton icon="refresh" title="Sample again" onClick={() => void load(size)} />}
      </div>
      {loading && <div class="progress" />}
      {error && <div class="banner error"><Icon name="error" /> {error}</div>}
      {res && res.fields.length === 0 && !loading && <div class="center-message">No documents to analyze.</div>}
      {res && res.fields.length > 0 && (
        <table class="grid schema-table">
          <thead><tr><th>Field</th><th>Types</th><th>Presence</th><th>Nulls</th><th>Examples</th><th aria-label="Actions" /></tr></thead>
          <tbody>{res.fields.map((f) => <SchemaRow key={f.path} f={f} depth={0} onFilter={onFilter} />)}</tbody>
        </table>
      )}
    </div>
  );
}

// Indexes ------------------------------------------------------------------------

const BLANK_INDEX: CreateIndexInput = { keys: '', name: '', unique: false, sparse: false, hidden: false, ttlSeconds: '', partial: '' };

export function CreateIndexForm({ initialKeys, fields, needFields, onCreated, onCancel }: {
  initialKeys?: string; fields?: FieldSuggestion[]; needFields?: () => void; onCreated: (name: string) => void; onCancel: () => void;
}) {
  const [f, setF] = useState<CreateIndexInput>({ ...BLANK_INDEX, keys: initialKeys ?? '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<CreateIndexInput>) => setF((v) => ({ ...v, ...p }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api('createIndex', f));
    } catch (e) {
      const err = e as RpcFailure;
      if (err.message !== 'Cancelled') setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="card form">
      <div class="card-title">Create Index</div>
      <label class="form-field"><span>Fields</span>
        <CodeInput value={f.keys} onChange={(keys) => set({ keys })} onSubmit={() => void submit()} mode="keys" fields={fields} onNeedFields={needFields} label="Index fields" placeholder='{ email: 1 }, { createdAt: -1 }, { title: "text" }' autoFocus />
      </label>
      <div class="form-row">
        <label class="form-field grow"><span>Name (optional)</span>
          <input class="input" value={f.name} onInput={(e) => set({ name: e.currentTarget.value })} placeholder="Generated from the fields" />
        </label>
        <label class="form-field"><span>TTL (seconds)</span>
          <input class="input" inputMode="numeric" value={f.ttlSeconds} onInput={(e) => set({ ttlSeconds: e.currentTarget.value })} placeholder="None" />
        </label>
      </div>
      <label class="form-field"><span>Partial filter (optional)</span>
        <CodeInput value={f.partial} onChange={(partial) => set({ partial })} label="Partial filter" placeholder="{ active: true }" />
      </label>
      <div class="checks">
        <label><input type="checkbox" checked={f.unique} onChange={(e) => set({ unique: e.currentTarget.checked })} /> Unique</label>
        <label><input type="checkbox" checked={f.sparse} onChange={(e) => set({ sparse: e.currentTarget.checked })} /> Sparse</label>
        <label><input type="checkbox" checked={f.hidden} onChange={(e) => set({ hidden: e.currentTarget.checked })} /> Hidden</label>
      </div>
      {error && <div class="query-error" role="alert"><Icon name="error" /> {error}</div>}
      <div class="dialog-buttons">
        <Button onClick={onCancel}>Cancel</Button>
        <Button primary onClick={() => void submit()} disabled={busy}>{busy ? 'Creating…' : 'Create Index'}</Button>
      </div>
    </div>
  );
}

export function IndexesTab({ init, fields, needFields, onCopy }: { init: CollectionInit; fields: FieldSuggestion[]; needFields: () => void; onCopy: (t: string, l?: string) => void }) {
  const [list, setList] = useState<IndexInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => {
    setError(null);
    api('indexes').then(setList).catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);
  if (init.collectionType === 'view') return <div class="tab-body"><div class="center-message">Views use the indexes of their source collection.</div></div>;
  return (
    <div class="tab-body scroll">
      <div class="toolbar">
        <span class="muted">{list ? `${list.length} index${list.length === 1 ? '' : 'es'}` : 'Loading…'}</span>
        <div class="grow" />
        {init.canWrite && <IconButton icon="add" label="Create Index" title="Create an index" onClick={() => setCreating(true)} />}
        <IconButton icon="refresh" title="Refresh" onClick={load} />
      </div>
      {error && <div class="banner error"><Icon name="error" /> {error}</div>}
      {creating && <CreateIndexForm fields={fields} needFields={needFields} onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {list && (
        <table class="grid">
          <thead><tr><th>Name</th><th>Fields</th><th>Type</th><th>Properties</th><th>Size</th><th title="Operations since the server started or the index was created">Uses</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {list.map((ix) => (
              <tr key={ix.name}>
                <td class="mono">{ix.name}</td>
                <td class="mono index-keys" title={ix.keyText}>
                  {ix.keys.map((k) => (
                    <span class="key-chip" key={k.field}>
                      {k.field}
                      <Icon name={k.direction === 'ascending' ? 'arrow-up' : k.direction === 'descending' ? 'arrow-down' : 'symbol-key'} />
                    </span>
                  ))}
                </td>
                <td>{ix.kind}</td>
                <td>
                  <div class="type-list">
                    {ix.unique && <span class="prop-chip">unique</span>}
                    {ix.sparse && <span class="prop-chip">sparse</span>}
                    {ix.hidden && <span class="prop-chip warn">hidden</span>}
                    {ix.ttlSeconds !== undefined && <span class="prop-chip" title={`Documents expire after ${ix.ttlSeconds} seconds`}>TTL {formatTtl(ix.ttlSeconds)}</span>}
                    {ix.partialText && <span class="prop-chip" title={ix.partialText}>partial</span>}
                  </div>
                </td>
                <td class="num">{ix.sizeBytes !== undefined ? formatBytes(ix.sizeBytes) : '—'}</td>
                <td class={`num${ix.ops === 0 && !ix.isDefault ? ' warn-text' : ''}`} title={ix.since ? `Since ${ix.since}` : undefined}>{ix.ops !== undefined ? formatNumber(ix.ops) : '—'}</td>
                <td class="row-end">
                  <IconButton icon="copy" title="Copy index definition" onClick={() => onCopy(ix.keyText, 'index fields')} />
                  {init.canWrite && !ix.isDefault && (
                    <>
                      <IconButton icon={ix.hidden ? 'eye' : 'eye-closed'} title={ix.hidden ? 'Unhide index' : 'Hide index from the query planner'} onClick={() => void api('setIndexHidden', { name: ix.name, hidden: !ix.hidden }).then(load).catch((e: Error) => { if (e.message !== 'Cancelled') setError(e.message); })} />
                      <IconButton icon="trash" title="Drop index" onClick={() => void api('dropIndex', { name: ix.name }).then((ok) => { if (ok) load(); }).catch((e: Error) => setError(e.message))} />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatTtl(s: number): string {
  if (s % 86400 === 0 && s > 0) return `${s / 86400}d`;
  if (s % 3600 === 0 && s > 0) return `${s / 3600}h`;
  if (s % 60 === 0 && s > 0) return `${s / 60}m`;
  return `${s}s`;
}

// Stats --------------------------------------------------------------------------

export function StatsTab() {
  const [s, setS] = useState<StatsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => { api('stats').then(setS).catch((e: Error) => setError(e.message)); };
  useEffect(load, []);
  if (error) return <div class="tab-body"><div class="banner error"><Icon name="error" /> {error}</div></div>;
  if (!s) return <div class="tab-body"><div class="center-message"><Icon name="loading" spin /></div></div>;
  const tile = (label: string, value: string) => <div class="stat"><div class="stat-value">{value}</div><div class="stat-label">{label}</div></div>;
  return (
    <div class="tab-body scroll padded">
      {s.type !== 'view' && (
        <div class="stats">
          {tile('Documents', s.count !== null ? formatNumber(s.count) : '—')}
          {tile('Avg document', formatBytes(s.avgObjSize))}
          {tile('Data size', formatBytes(s.size))}
          {tile('Storage size', formatBytes(s.storageSize))}
          {tile('Indexes', s.nindexes !== null ? formatNumber(s.nindexes) : '—')}
          {tile('Index size', formatBytes(s.totalIndexSize))}
        </div>
      )}
      {s.capped && <p class="muted"><Icon name="info" /> This is a capped collection.</p>}
      {s.viewOn && <p><Icon name="eye" /> View on <code>{s.viewOn}</code></p>}
      {s.pipelineText && <><h3>View pipeline</h3><pre class="code-block">{s.pipelineText}</pre></>}
      {s.validatorText && <><h3>Validation rules</h3><pre class="code-block">{s.validatorText}</pre></>}
    </div>
  );
}

// Explain ------------------------------------------------------------------------

function StageNode({ s }: { s: PlanStage }) {
  const scan = s.stage === 'COLLSCAN';
  return (
    <div class="plan-node">
      <div class={`plan-stage${scan ? ' warn' : s.stage.includes('IXSCAN') ? ' good' : ''}`}>
        <strong>{s.stage}</strong>
        {s.detail && <span class="mono muted" title={s.detail}>{s.detail}</span>}
        <span class="plan-metrics">
          {s.docs !== undefined && <span>{formatNumber(s.docs)} returned</span>}
          {s.keys !== undefined && s.stage.includes('IXSCAN') && <span>{formatNumber(s.keys)} keys</span>}
          {s.ms !== undefined && <span>{s.ms} ms</span>}
        </span>
      </div>
      {s.children.map((c, i) => <StageNode key={i} s={c} />)}
    </div>
  );
}

export function ExplainPanel({ explain, canCreate, onClose, onCopy, onChanged }: {
  explain: ExplainSummary; canCreate: boolean; onClose: () => void; onCopy: (t: string, l?: string) => void; onChanged: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const tile = (label: string, value: string, warn = false) => <div class={`stat small${warn ? ' warn' : ''}`}><div class="stat-value">{value}</div><div class="stat-label">{label}</div></div>;
  const v = (n: number | null) => (n === null ? '—' : formatNumber(n));
  return (
    <section class="explain" aria-label="Query plan">
      <div class="explain-head">
        <Icon name="dashboard" />
        <strong>Query plan</strong>
        <span class={`pill ${explain.collectionScan ? 'bad' : 'ok'}`}>{explain.collectionScan ? 'Collection scan' : explain.indexes.length ? `Index: ${explain.indexes.join(', ')}` : 'No scan'}</span>
        <div class="grow" />
        <IconButton icon="json" title="Show or hide the raw plan" active={showRaw} onClick={() => setShowRaw(!showRaw)} />
        <IconButton icon="copy" title="Copy the raw plan" onClick={() => onCopy(explain.raw, 'plan')} />
        <IconButton icon="close" title="Close" onClick={onClose} />
      </div>
      <div class="stats">
        {tile('Time', explain.ms === null ? '—' : `${explain.ms} ms`)}
        {tile('Returned', v(explain.returned))}
        {tile('Docs examined', v(explain.docsExamined), explain.collectionScan)}
        {tile('Keys examined', v(explain.keysExamined))}
        {tile('Rejected plans', formatNumber(explain.rejectedPlans))}
      </div>
      {explain.tips.map((t, i) => (
        <div class="tip" key={i}>
          <Icon name="lightbulb" />
          <span class="grow">{t.text}{t.suggestKeys && <> Suggested: <code>{t.suggestKeys}</code></>}</span>
          {t.suggestKeys && canCreate && <Button onClick={() => setCreating(t.suggestKeys!)}>Create Index…</Button>}
        </div>
      ))}
      {creating !== null && <CreateIndexForm initialKeys={creating} onCancel={() => setCreating(null)} onCreated={() => { setCreating(null); onChanged(); }} />}
      {explain.stages && <div class="plan"><StageNode s={explain.stages} /></div>}
      {showRaw && <pre class="code-block">{explain.raw}</pre>}
    </section>
  );
}

// Aggregation --------------------------------------------------------------------

interface AggState { stages: AggregationStage[] }

export function AggregationTab({ init, fields, needFields, onCopy }: { init: CollectionInit; fields: FieldSuggestion[]; needFields: () => void; onCopy: (t: string, l?: string) => void }) {
  const initial = useMemo(() => getState<AggState>().stages, []);
  const [stages, setStages] = useState<AggregationStage[]>(initial?.length ? initial : [{ op: '$match', body: '', enabled: true }]);
  const [result, setResult] = useState<AggregateResult | null>(null);
  const [view, setView] = useState<ViewMode>('json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; stage?: number } | null>(null);
  const req = useRef<string | null>(null);

  useEffect(() => { patchState({ stages }); }, [stages]);

  const set = (i: number, p: Partial<AggregationStage>) => setStages((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: number) => setStages((s) => {
    const n = [...s];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    return n;
  });

  const preview = async () => {
    const id = newRequestId();
    req.current = id;
    setBusy(true);
    setError(null);
    try {
      setResult(await api('aggregate', { stages, limit: 20, requestId: id }));
    } catch (e) {
      const err = e as RpcFailure;
      if (!err.cancelled) setError({ message: err.message, stage: err.stage });
    } finally {
      setBusy(false);
      req.current = null;
    }
  };

  const hasOutput = stages.some((s) => s.enabled && (s.op === '$out' || s.op === '$merge'));

  return (
    <div class="tab-body scroll">
      <div class="toolbar">
        <span class="muted">Build a pipeline stage by stage. Preview runs on demand and shows up to 20 results.</span>
        <div class="grow" />
        <IconButton icon="copy" title="Copy the pipeline" onClick={() => onCopy(`[\n${stages.filter((s) => s.enabled).map((s) => `  { ${s.op}: ${s.body.trim() || '{}'} }`).join(',\n')}\n]`, 'pipeline')} />
        <IconButton icon="notebook" title="Open in a playground" onClick={() => void api('aggregationToPlayground', { stages })} />
        {hasOutput && init.canWrite && <Button onClick={() => void api('runAggregationToOutput', { stages }).catch((e: Error) => setError({ message: e.message }))} title="Runs the full pipeline, including $out or $merge">Run with Output</Button>}
        {busy
          ? <Button onClick={() => { if (req.current) void api('cancel', { requestId: req.current }); }}><Icon name="debug-stop" /> Cancel</Button>
          : <Button primary onClick={() => void preview()}><Icon name="play" /> Preview</Button>}
      </div>
      <div class="stages">
        {stages.map((s, i) => {
          const template = AGG_STAGES.find(([op]) => op === s.op)?.[2];
          const stageError = error?.stage === i;
          return (
            <div class={`stage${s.enabled ? '' : ' disabled'}${stageError ? ' has-error' : ''}`} key={i}>
              <div class="stage-head">
                <span class="stage-num">{i + 1}</span>
                <select class="select" aria-label={`Stage ${i + 1} operator`} value={s.op} onChange={(e) => set(i, { op: e.currentTarget.value })}>
                  {AGG_STAGES.map(([op, doc]) => <option key={op} value={op} title={doc}>{op}</option>)}
                </select>
                <span class="muted grow">{AGG_STAGES.find(([op]) => op === s.op)?.[1]}</span>
                <IconButton icon={s.enabled ? 'eye' : 'eye-closed'} title={s.enabled ? 'Disable this stage' : 'Enable this stage'} onClick={() => set(i, { enabled: !s.enabled })} />
                <IconButton icon="arrow-up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon="arrow-down" title="Move down" disabled={i === stages.length - 1} onClick={() => move(i, 1)} />
                <IconButton icon="trash" title="Remove this stage" onClick={() => setStages((x) => x.filter((_, j) => j !== i))} />
              </div>
              <CodeInput value={s.body} onChange={(body) => set(i, { body })} onSubmit={() => void preview()} mode="stage" fields={fields} onNeedFields={needFields} label={`${s.op} body`} placeholder={template} minRows={1} invalid={stageError || !isValidStage(s.body)} />
              {stageError && <div class="query-error"><Icon name="error" /> {error?.message}</div>}
            </div>
          );
        })}
        <button type="button" class="add-stage" onClick={() => setStages((s) => [...s, { op: s.length ? '$group' : '$match', body: '', enabled: true }])}><Icon name="add" /> Add Stage</button>
      </div>
      {busy && <div class="progress" />}
      {error && error.stage === undefined && <div class="banner error"><Icon name="error" /> {error.message}</div>}
      {result && (
        <>
          <div class="toolbar">
            <strong>Output</strong>
            <span class="muted">{formatNumber(result.docs.length)}{result.truncated ? '+' : ''} documents · {result.ms} ms</span>
            <div class="grow" />
            <ViewSwitch view={view} onChange={setView} />
          </div>
          {result.docs.length
            ? <div class="agg-results"><DocsView view={view} docs={result.docs} actions={{ onCopy }} /></div>
            : <div class="center-message">No output.</div>}
        </>
      )}
    </div>
  );
}

function isValidStage(body: string): boolean {
  if (!tokenize(body).some((t) => t.type !== 'comment')) return true;
  try {
    parseShell(body);
    return true;
  } catch {
    return false;
  }
}
