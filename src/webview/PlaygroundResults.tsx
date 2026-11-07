import { useEffect, useState } from 'preact/hooks';
import { client, onEvent } from './rpc';
import { Button, Icon, IconButton, MenuHost, openMenu } from './ui';
import { DocsView, JsonView, ViewSwitch, type DocActions, type ViewMode } from './DocViews';
import { wireToShell } from '../shared/wire';
import type { PlaygroundApi, PlaygroundBlock, PlaygroundEvent } from '../shared/protocol';

const api = client<PlaygroundApi>();

function ResultBlock({ block, actions, view }: { block: PlaygroundBlock; actions: DocActions; view: ViewMode }) {
  if (block.kind === 'print') return <pre class="pg-print">{block.text}</pre>;
  if (block.kind === 'error') {
    return (
      <div class="banner error pg-error" role="alert">
        <Icon name="error" />
        <span>{block.line ? `Line ${block.line}: ` : ''}{block.text}</span>
      </div>
    );
  }
  const docs = block.docs;
  const text = docs ? `[\n${docs.map((d) => wireToShell(d.value)).join(',\n')}\n]` : block.value ? wireToShell(block.value) : '';
  return (
    <section class="pg-block">
      <header class="pg-head">
        {block.line && <span class="pg-line">Line {block.line}</span>}
        <code class="pg-label" title={block.label}>{block.label}</code>
        <div class="grow" />
        {docs && <span class="muted">{docs.length}{block.truncated ? '+' : ''} doc{docs.length === 1 ? '' : 's'}{block.ms !== undefined ? ` · ${block.ms} ms` : ''}</span>}
        <IconButton icon="copy" title="Copy result" onClick={() => actions.onCopy(text, 'result')} />
        <IconButton icon="cloud-download" title="Save result" onClick={(e) => openMenu(e, [
          { label: 'Save as JSON', onSelect: () => void api('exportBlock', { id: block.id, format: 'json' }) },
          { label: 'Save as CSV', onSelect: () => void api('exportBlock', { id: block.id, format: 'csv' }) },
        ])} />
      </header>
      {docs
        ? docs.length ? <DocsView view={view} docs={docs} actions={actions} /> : <div class="muted pg-empty">No documents.</div>
        : block.value && (block.value.t === 'obj' || block.value.t === 'arr')
          ? <JsonView docs={[{ id: null, value: block.value }]} actions={actions} />
          : <pre class="pg-value">{text}</pre>}
      {block.truncated && <div class="hint pg-truncated">Showing the first {docs?.length} documents. Change this in "mongoViewer.playground.resultLimit".</div>}
    </section>
  );
}

export function PlaygroundResults() {
  const [blocks, setBlocks] = useState<PlaygroundBlock[]>([]);
  const [head, setHead] = useState<{ title: string; target: string; environment: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<{ ms: number; status: string } | null>(null);
  const [view, setView] = useState<ViewMode>('json');

  useEffect(() => {
    const off = onEvent<PlaygroundEvent>((e) => {
      if (e.name === 'start') {
        setHead(e);
        setBlocks([]);
        setRunning(true);
        setFinished(null);
      } else if (e.name === 'block') {
        setBlocks((b) => [...b, e.block]);
      } else if (e.name === 'finish') {
        setRunning(false);
        setFinished(e);
      }
    });
    void api('ready');
    return off;
  }, []);

  const actions: DocActions = { onCopy: (text, label) => void api('copyText', { text, label }) };

  return (
    <div class="app pg">
      <header class="topbar">
        <div class="crumbs">
          {head?.environment === 'production' && <span class="env-badge env-production">PRODUCTION</span>}
          <span class="crumb current">{head ? head.target : 'Playground results'}</span>
          {head && <span class="muted">· {head.title}</span>}
        </div>
        <div class="topbar-tools">
          {finished && <span class="muted">{finished.status === 'done' ? 'Finished' : finished.status === 'error' ? 'Failed' : 'Cancelled'} in {finished.ms} ms</span>}
          {running && <Button onClick={() => void api('cancel')}><Icon name="debug-stop" /> Cancel</Button>}
          <ViewSwitch view={view} onChange={setView} />
        </div>
      </header>
      {running && <div class="progress" role="progressbar" />}
      <main class="pg-results">
        {blocks.map((b) => <ResultBlock key={b.id} block={b} actions={actions} view={view} />)}
        {finished?.status === 'done' && blocks.length === 0 && <div class="center-message">The script ran and produced no output.</div>}
        {!head && <div class="center-message"><Icon name="play" /> Run a playground to see results here.</div>}
      </main>
      <MenuHost />
    </div>
  );
}
