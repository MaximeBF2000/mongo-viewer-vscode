// Table, JSON and Tree renderers for documents. Used by the collection viewer,
// the aggregation preview and playground results.
import { useMemo, useRef, useState } from 'preact/hooks';
import { formatKey, scalarToShell, TYPE_LABELS, wireToCopyText, wireToShell, type Wire, type WireDoc } from '../shared/wire';
import { Icon, IconButton, openMenu, type MenuItem } from './ui';

export type ViewMode = 'table' | 'json' | 'tree';

/** What the viewer can do with documents. Omitted handlers hide the action. */
export interface DocActions {
  onOpen?: (doc: WireDoc) => void;
  onCopy: (text: string, label?: string) => void;
  onDuplicate?: (doc: WireDoc) => void;
  onDelete?: (doc: WireDoc) => void;
  onEditField?: (doc: WireDoc, path: string[], value: Wire) => void;
  onAddField?: (doc: WireDoc, parent: string[]) => void;
  onRemoveField?: (doc: WireDoc, path: string[]) => void;
  onFilterBy?: (path: string[], value: Wire) => void;
}

const VALUE_CLASS: Partial<Record<Wire['t'], string>> = {
  str: 'v-string', int: 'v-number', dbl: 'v-number', long: 'v-number', dec: 'v-number', bool: 'v-bool', null: 'v-null', undef: 'v-null',
  oid: 'v-oid', date: 'v-date', uuid: 'v-oid', regex: 'v-regex', bin: 'v-special', ts: 'v-special', min: 'v-special', max: 'v-special',
  code: 'v-special', dbref: 'v-special', sym: 'v-special',
};

const summary = (w: Wire): string => {
  if (w.t === 'obj') return `{ ${w.e.length} field${w.e.length === 1 ? '' : 's'} }`;
  if (w.t === 'arr') return `[ ${w.a.length} item${w.a.length === 1 ? '' : 's'} ]`;
  return '';
};

/** Compact cell text for the table. */
function cellText(w: Wire): string {
  switch (w.t) {
    case 'str': return w.v;
    case 'oid': return w.v;
    case 'date': return w.v ? w.v.replace('T', ' ').replace(/\.000Z$|Z$/, '') : 'Invalid date';
    case 'long': case 'dec': return w.v;
    case 'bin': return `Binary (${w.size} bytes)`;
    case 'obj': case 'arr': return summary(w);
    default: return scalarToShell(w) ?? '';
  }
}

function fieldMenu(doc: WireDoc, path: string[], value: Wire, a: DocActions): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Copy Value', icon: 'copy', onSelect: () => a.onCopy(wireToCopyText(value), 'value') },
    { label: 'Copy as Shell Literal', onSelect: () => a.onCopy(wireToShell(value, true), 'value') },
    { label: 'Copy Field Path', onSelect: () => a.onCopy(path.join('.'), 'field path') },
  ];
  if (a.onFilterBy && value.t !== 'obj' && value.t !== 'arr') {
    items.push({ separator: true }, { label: 'Filter by This Value', icon: 'filter', onSelect: () => a.onFilterBy!(path, value) });
  }
  if (a.onEditField && path[0] !== '_id') {
    items.push(
      { separator: true },
      { label: 'Edit Value…', icon: 'edit', onSelect: () => a.onEditField!(doc, path, value) },
      { label: value.t === 'obj' ? 'Add Field Here…' : 'Add Field…', icon: 'add', onSelect: () => a.onAddField?.(doc, value.t === 'obj' ? path : path.slice(0, -1)) },
      { label: 'Remove Field', icon: 'trash', danger: true, onSelect: () => a.onRemoveField?.(doc, path) },
    );
  }
  items.push({ separator: true }, ...documentMenu(doc, a));
  return items;
}

function documentMenu(doc: WireDoc, a: DocActions): MenuItem[] {
  const items: MenuItem[] = [];
  if (a.onOpen) items.push({ label: 'Open Document', icon: 'go-to-file', hint: 'Double-click', onSelect: () => a.onOpen!(doc) });
  items.push({ label: 'Copy Document', icon: 'json', onSelect: () => a.onCopy(wireToShell(doc.value, true), 'document') });
  if (a.onDuplicate) items.push({ label: 'Duplicate Document', icon: 'files', onSelect: () => a.onDuplicate!(doc) });
  if (a.onDelete) items.push({ label: 'Delete Document', icon: 'trash', danger: true, onSelect: () => a.onDelete!(doc) });
  return items;
}

export function ScalarValue({ w }: { w: Wire }) {
  return <span class={VALUE_CLASS[w.t] ?? ''}>{scalarToShell(w)}</span>;
}

// Table -------------------------------------------------------------------------

export interface TableProps {
  docs: WireDoc[];
  actions: DocActions;
  hiddenColumns?: Set<string>;
  sort?: Record<string, number>;
  onSort?: (field: string, additive: boolean) => void;
  selected?: Set<string>;
  onToggleSelect?: (id: string, range: boolean) => void;
  onToggleAll?: () => void;
  cursor?: number;
  onCursor?: (index: number) => void;
}

export function columnsOf(docs: WireDoc[]): string[] {
  const seen = new Set<string>();
  for (const d of docs) if (d.value.t === 'obj') for (const [k] of d.value.e) seen.add(k);
  return [...seen];
}

export function TableView(props: TableProps) {
  const { docs, actions, selected } = props;
  const columns = useMemo(() => columnsOf(docs).filter((c) => !props.hiddenColumns?.has(c)), [docs, props.hiddenColumns]);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const resizing = useRef<{ col: string; x: number; w: number } | null>(null);

  const startResize = (e: MouseEvent, col: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement!;
    resizing.current = { col, x: e.clientX, w: th.getBoundingClientRect().width };
    const move = (ev: MouseEvent) => {
      const r = resizing.current;
      if (r) setWidths((w) => ({ ...w, [r.col]: Math.max(50, r.w + ev.clientX - r.x) }));
    };
    const up = () => {
      resizing.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const canSelect = !!props.onToggleSelect;
  const allSelected = canSelect && docs.length > 0 && docs.every((d) => d.id && selected?.has(d.id));

  return (
    <div class="table-wrap" role="region" aria-label="Documents" tabIndex={-1}>
      <table class="doc-table">
        <thead>
          <tr>
            {canSelect && (
              <th class="col-check">
                <input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={() => props.onToggleAll?.()} />
              </th>
            )}
            {columns.map((c) => {
              const dir = props.sort?.[c];
              return (
                <th
                  key={c}
                  class={`${c === '_id' ? 'col-id' : ''}${props.onSort ? ' sortable' : ''}`}
                  style={widths[c] ? { width: `${widths[c]}px`, maxWidth: `${widths[c]}px`, minWidth: `${widths[c]}px` } : undefined}
                  title={props.onSort ? `Sort by ${c}. Shift-click to add to the sort.` : c}
                  aria-sort={dir ? (dir > 0 ? 'ascending' : 'descending') : undefined}
                  onClick={(e) => props.onSort?.(c, e.shiftKey)}
                >
                  <span class="th-label">{c}</span>
                  {dir ? <Icon name={dir > 0 ? 'arrow-up' : 'arrow-down'} /> : null}
                  <span class="resizer" onMouseDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
                </th>
              );
            })}
            {(actions.onOpen || actions.onDelete) && <th class="col-actions" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {docs.map((doc, i) => {
            const map = doc.value.t === 'obj' ? new Map(doc.value.e) : new Map<string, Wire>();
            const isSelected = !!(doc.id && selected?.has(doc.id));
            return (
              <tr
                key={doc.id ?? i}
                class={`${isSelected ? 'selected' : ''}${props.cursor === i ? ' cursor' : ''}`}
                onClick={() => props.onCursor?.(i)}
                onDblClick={() => actions.onOpen?.(doc)}
                onContextMenu={(e) => openMenu(e, documentMenu(doc, actions))}
              >
                {canSelect && (
                  <td class="col-check" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="Select document"
                      checked={isSelected}
                      disabled={!doc.id}
                      onClick={(e) => { if (doc.id) { e.preventDefault(); props.onToggleSelect!(doc.id, e.shiftKey); } }}
                    />
                  </td>
                )}
                {columns.map((c) => {
                  const v = map.get(c);
                  if (!v) return <td key={c} class={`cell-missing ${c === '_id' ? 'col-id' : ''}`} />;
                  const text = cellText(v);
                  return (
                    <td
                      key={c}
                      class={`${VALUE_CLASS[v.t] ?? 'v-container'} ${c === '_id' ? 'col-id' : ''}`}
                      style={widths[c] ? { maxWidth: `${widths[c]}px`, minWidth: `${widths[c]}px` } : undefined}
                      title={`${TYPE_LABELS[v.t]}\n${v.t === 'obj' || v.t === 'arr' ? wireToShell(v, true).slice(0, 1000) : wireToCopyText(v).slice(0, 1000)}`}
                      onContextMenu={(e) => openMenu(e, fieldMenu(doc, [c], v, actions))}
                    >
                      {text.length > 300 ? `${text.slice(0, 300)}…` : text}
                    </td>
                  );
                })}
                {(actions.onOpen || actions.onDelete) && <td class="col-actions"><RowActions doc={doc} actions={actions} /></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowActions({ doc, actions }: { doc: WireDoc; actions: DocActions }) {
  return (
    <span class="row-actions" onDblClick={(e) => e.stopPropagation()}>
      {actions.onOpen && <IconButton icon="edit" title="Open document" onClick={() => actions.onOpen!(doc)} />}
      <IconButton icon="copy" title="Copy document" onClick={() => actions.onCopy(wireToShell(doc.value, true), 'document')} />
      {actions.onDuplicate && <IconButton icon="files" title="Duplicate document" onClick={() => actions.onDuplicate!(doc)} />}
      {actions.onDelete && <IconButton icon="trash" title="Delete document" onClick={() => actions.onDelete!(doc)} />}
    </span>
  );
}

// JSON --------------------------------------------------------------------------

function JsonNode({ k, w, doc, path, actions, depth, comma }: {
  k?: string; w: Wire; doc: WireDoc; path: string[]; actions: DocActions; depth: number; comma: boolean;
}) {
  const isContainer = w.t === 'obj' || w.t === 'arr';
  const count = w.t === 'obj' ? w.e.length : w.t === 'arr' ? w.a.length : 0;
  const [open, setOpen] = useState(depth < 3 && count < 60);
  const keyEl = k !== undefined ? (
    <>
      <span class="j-key">{formatKey(k)}</span>
      <span class="j-punct">: </span>
    </>
  ) : null;
  const menu = (e: MouseEvent) => {
    if (path.length) openMenu(e, fieldMenu(doc, path, w, actions));
    else openMenu(e, documentMenu(doc, actions));
  };
  if (!isContainer || count === 0) {
    return (
      <div class="j-line" onContextMenu={menu}>
        <span class="j-chevron" />
        {keyEl}
        {isContainer ? <span class="j-punct">{w.t === 'obj' ? '{}' : '[]'}</span> : <ScalarValue w={w} />}
        {comma && <span class="j-punct">,</span>}
      </div>
    );
  }
  const [o, c] = w.t === 'obj' ? ['{', '}'] : ['[', ']'];
  const inline = w.t === 'arr' && count <= 8 && w.a.every((x) => x.t !== 'obj' && x.t !== 'arr') && wireToShell(w, false).length < 70;
  if (inline && w.t === 'arr') {
    return (
      <div class="j-line" onContextMenu={menu}>
        <span class="j-chevron" />
        {keyEl}
        <span class="j-punct">[</span>
        {w.a.map((x, i) => (
          <>
            <ScalarValue w={x} />
            {i < count - 1 && <span class="j-punct">, </span>}
          </>
        ))}
        <span class="j-punct">]</span>
        {comma && <span class="j-punct">,</span>}
      </div>
    );
  }
  return (
    <div>
      <div class="j-line" onContextMenu={menu}>
        <button type="button" class="j-chevron toggle" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
        {keyEl}
        <span class="j-punct">{o}</span>
        {!open && (
          <>
            <button type="button" class="j-summary" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{count} {w.t === 'obj' ? (count === 1 ? 'field' : 'fields') : (count === 1 ? 'item' : 'items')}</button>
            <span class="j-punct">{c}</span>
            {comma && <span class="j-punct">,</span>}
          </>
        )}
      </div>
      {open && (
        <>
          <div class="j-children">
            {w.t === 'obj'
              ? w.e.map(([ck, cv], i) => <JsonNode key={ck} k={ck} w={cv} doc={doc} path={[...path, ck]} actions={actions} depth={depth + 1} comma={i < count - 1} />)
              : w.a.map((cv, i) => <JsonNode key={i} w={cv} doc={doc} path={[...path, String(i)]} actions={actions} depth={depth + 1} comma={i < count - 1} />)}
          </div>
          <div class="j-line"><span class="j-chevron" /><span class="j-punct">{c}</span>{comma && <span class="j-punct">,</span>}</div>
        </>
      )}
    </div>
  );
}

export function JsonView({ docs, actions, cursor, onCursor, selected, onToggleSelect }: {
  docs: WireDoc[]; actions: DocActions; cursor?: number; onCursor?: (i: number) => void; selected?: Set<string>; onToggleSelect?: (id: string, range: boolean) => void;
}) {
  return (
    <div class="doc-list json-view">
      {docs.map((doc, i) => (
        <div
          class={`doc-card${cursor === i ? ' cursor' : ''}${doc.id && selected?.has(doc.id) ? ' selected' : ''}`}
          key={doc.id ?? i}
          onClick={() => onCursor?.(i)}
          onDblClick={() => actions.onOpen?.(doc)}
        >
          <div class="card-tools" onDblClick={(e) => e.stopPropagation()}>
            {onToggleSelect && doc.id && (
              <input type="checkbox" aria-label="Select document" checked={!!selected?.has(doc.id)} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSelect(doc.id!, e.shiftKey); }} />
            )}
            <RowActions doc={doc} actions={actions} />
          </div>
          <JsonNode w={doc.value} doc={doc} path={[]} actions={actions} depth={0} comma={false} />
        </div>
      ))}
    </div>
  );
}

// Tree --------------------------------------------------------------------------

function TreeRow({ k, w, doc, path, actions, depth }: { k: string; w: Wire; doc: WireDoc; path: string[]; actions: DocActions; depth: number }) {
  const isContainer = (w.t === 'obj' && w.e.length > 0) || (w.t === 'arr' && w.a.length > 0);
  const [open, setOpen] = useState(depth < 1);
  return (
    <>
      <div
        class="t-row"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => { if (isContainer) setOpen(!open); }}
        onContextMenu={(e) => openMenu(e, fieldMenu(doc, path, w, actions))}
      >
        <span class="t-chevron">{isContainer && <Icon name={open ? 'chevron-down' : 'chevron-right'} />}</span>
        <span class="t-key">{k}</span>
        <span class="t-value">{w.t === 'obj' || w.t === 'arr' ? <span class="v-container">{summary(w)}</span> : <ScalarValue w={w} />}</span>
        <span class="t-type">{TYPE_LABELS[w.t]}</span>
      </div>
      {open && isContainer && (w.t === 'obj'
        ? w.e.map(([ck, cv]) => <TreeRow key={ck} k={ck} w={cv} doc={doc} path={[...path, ck]} actions={actions} depth={depth + 1} />)
        : w.t === 'arr'
          ? w.a.map((cv, i) => <TreeRow key={i} k={String(i)} w={cv} doc={doc} path={[...path, String(i)]} actions={actions} depth={depth + 1} />)
          : null)}
    </>
  );
}

export function TreeView({ docs, actions, cursor, onCursor, selected, onToggleSelect }: {
  docs: WireDoc[]; actions: DocActions; cursor?: number; onCursor?: (i: number) => void; selected?: Set<string>; onToggleSelect?: (id: string, range: boolean) => void;
}) {
  return (
    <div class="doc-list tree-view">
      {docs.map((doc, i) => {
        const fields = doc.value.t === 'obj' ? doc.value.e : [];
        const idField = fields.find(([k]) => k === '_id')?.[1];
        return (
          <div
            class={`doc-card${cursor === i ? ' cursor' : ''}${doc.id && selected?.has(doc.id) ? ' selected' : ''}`}
            key={doc.id ?? i}
            onClick={() => onCursor?.(i)}
            onDblClick={() => actions.onOpen?.(doc)}
          >
            <div class="tree-head" onContextMenu={(e) => openMenu(e, documentMenu(doc, actions))}>
              <Icon name="symbol-object" />
              <span class="tree-title">{idField ? cellText(idField) : `Document ${i + 1}`}</span>
              <span class="tree-count">{fields.length} fields</span>
              <div class="card-tools" onDblClick={(e) => e.stopPropagation()}>
                {onToggleSelect && doc.id && (
                  <input type="checkbox" aria-label="Select document" checked={!!selected?.has(doc.id)} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSelect(doc.id!, e.shiftKey); }} />
                )}
                <RowActions doc={doc} actions={actions} />
              </div>
            </div>
            {fields.map(([k, v]) => <TreeRow key={k} k={k} w={v} doc={doc} path={[k]} actions={actions} depth={0} />)}
          </div>
        );
      })}
    </div>
  );
}

export function DocsView(props: TableProps & { view: ViewMode }) {
  const { view, docs, actions, cursor, onCursor, selected, onToggleSelect } = props;
  if (view === 'json') return <JsonView docs={docs} actions={actions} cursor={cursor} onCursor={onCursor} selected={selected} onToggleSelect={onToggleSelect} />;
  if (view === 'tree') return <TreeView docs={docs} actions={actions} cursor={cursor} onCursor={onCursor} selected={selected} onToggleSelect={onToggleSelect} />;
  return <TableView {...props} />;
}

export function ViewSwitch({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const opts: [ViewMode, string, string][] = [['table', 'table', 'Table view (1)'], ['json', 'json', 'JSON view (2)'], ['tree', 'list-tree', 'Tree view (3)']];
  return (
    <div class="segmented" role="radiogroup" aria-label="Display mode">
      {opts.map(([v, icon, title]) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} class={view === v ? 'active' : ''} title={title} aria-label={title} onClick={() => onChange(v)}>
          <Icon name={icon} />
        </button>
      ))}
    </div>
  );
}
