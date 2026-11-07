// Messages between webviews and the extension host. The host owns every database
// operation. Webviews only ask for things and display the answers.
import type { Wire, WireDoc } from './wire';

export interface QueryInput {
  filter: string;
  sort: string;
  project: string;
  /** Empty for no limit. */
  limit: string;
}

export interface FindRequest extends QueryInput {
  requestId: string;
  page: number;
  pageSize: number;
}

export interface FindResult {
  docs: WireDoc[];
  hasMore: boolean;
  ms: number;
  page: number;
  pageSize: number;
}

export interface CountResult {
  count: number | null;
  /** False for an estimate from collection metadata. */
  exact: boolean;
  timedOut?: boolean;
}

export interface SchemaField {
  name: string;
  path: string;
  count: number;
  presence: number;
  nulls: number;
  types: { type: string; count: number }[];
  elementTypes?: { type: string; count: number }[];
  samples: string[];
  children: SchemaField[];
}

export interface SchemaResult { sampled: number; fields: SchemaField[]; ms?: number }

export interface IndexInfo {
  name: string;
  keyText: string;
  keys: { field: string; direction: string }[];
  kind: string;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  ttlSeconds?: number;
  partialText?: string;
  sizeBytes?: number;
  ops?: number;
  since?: string;
  isDefault: boolean;
}

export interface CreateIndexInput {
  keys: string;
  name: string;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  ttlSeconds: string;
  partial: string;
}

export interface StatsResult {
  count: number | null;
  storageSize: number | null;
  size: number | null;
  avgObjSize: number | null;
  totalIndexSize: number | null;
  nindexes: number | null;
  capped: boolean;
  type: string;
  viewOn?: string;
  pipelineText?: string;
  validatorText?: string;
}

export interface ExplainSummary {
  ms: number | null;
  docsExamined: number | null;
  keysExamined: number | null;
  returned: number | null;
  collectionScan: boolean;
  indexes: string[];
  stages: PlanStage | null;
  rejectedPlans: number;
  sortInMemory: boolean;
  tips: { text: string; suggestKeys?: string }[];
  raw: string;
}

export interface PlanStage {
  stage: string;
  detail?: string;
  docs?: number;
  keys?: number;
  ms?: number;
  children: PlanStage[];
}

export interface AggregationStage { op: string; body: string; enabled: boolean }

export interface AggregateResult { docs: WireDoc[]; ms: number; truncated: boolean }

export interface AiResult {
  filter: string;
  sort: string;
  project: string;
  limit: string;
  explanation: string;
  model: string;
  ms: number;
  autoRun: boolean;
}

export interface SavedQuery extends QueryInput {
  id: string;
  name?: string;
  at: number;
}

export interface FieldEdit { id: string; path: string[]; value: string }

export type BulkScope = { ids: string[] } | { query: QueryInput };

export type ExportScope =
  | { kind: 'selected'; ids: string[] }
  | { kind: 'query'; query: QueryInput }
  | { kind: 'page'; query: QueryInput; page: number; pageSize: number };

export interface CollectionInit {
  connectionId: string;
  connectionName: string;
  hostLabel: string;
  environment: string;
  color?: string;
  readOnly: boolean;
  database: string;
  collection: string;
  collectionType: string;
  canWrite: boolean;
  pageSize: number;
  defaultView: 'table' | 'json' | 'tree';
  tab: CollectionTab;
  aiEnabled: boolean;
  aiModel: string;
  /** Set when the panel was restored and should not re-run a user query by itself. */
  restored: boolean;
}

export type CollectionTab = 'documents' | 'aggregation' | 'schema' | 'indexes' | 'stats';

/** Requests a collection webview can make, as [params, result]. */
export interface CollectionApi {
  init: [void, CollectionInit];
  find: [FindRequest, FindResult];
  cancel: [{ requestId: string }, void];
  count: [{ filter: string }, CountResult];
  suggestFields: [void, { path: string; type: string }[]];
  schema: [{ sampleSize: number; requestId: string }, SchemaResult];
  indexes: [void, IndexInfo[]];
  createIndex: [CreateIndexInput, string];
  dropIndex: [{ name: string }, boolean];
  setIndexHidden: [{ name: string; hidden: boolean }, void];
  stats: [void, StatsResult];
  explain: [QueryInput & { requestId: string }, ExplainSummary];
  aggregate: [{ stages: AggregationStage[]; limit: number; requestId: string }, AggregateResult];
  aggregationToPlayground: [{ stages: AggregationStage[] }, void];
  runAggregationToOutput: [{ stages: AggregationStage[] }, void];
  openDocument: [{ id: string }, void];
  insertDocument: [void, void];
  duplicateDocument: [{ id: string }, void];
  deleteDocuments: [{ ids: string[] }, number];
  deleteByQuery: [{ query: QueryInput }, number];
  updateField: [FieldEdit, void];
  removeField: [{ id: string; path: string[] }, boolean];
  bulkUpdate: [{ scope: BulkScope; update: string }, number];
  promptBulkUpdate: [{ scope: BulkScope; count: number }, number];
  copyText: [{ text: string; label?: string }, void];
  exportDocs: [{ scope: ExportScope; format?: 'json' | 'csv' }, void];
  importDocs: [void, void];
  toPlayground: [QueryInput, void];
  openShell: [void, void];
  history: [void, { history: SavedQuery[]; saved: SavedQuery[] }];
  recordHistory: [QueryInput, void];
  saveQuery: [QueryInput, SavedQuery | null];
  deleteSaved: [{ id: string }, void];
  setPageSize: [{ pageSize: number }, void];
  ai: [{ prompt: string; requestId: string }, AiResult];
  chooseAiModel: [void, string];
  showError: [{ message: string }, void];
}

/** Events the host pushes to a collection webview. */
export type CollectionEvent =
  | { name: 'refresh' }
  | { name: 'setTab'; tab: CollectionTab }
  | { name: 'aiProgress'; requestId: string; status: string };

export interface ConnectionFormData {
  id?: string;
  name: string;
  uri: string;
  password: string;
  hasSavedPassword?: boolean;
  environment: string;
  color: string;
  readOnly: boolean;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshIdentityFile: string;
}

export interface ConnectionFormApi {
  load: [void, ConnectionFormData];
  test: [ConnectionFormData, { ok: boolean; message: string }];
  save: [{ form: ConnectionFormData; connect: boolean }, { ok: boolean; message?: string }];
  cancel: [void, void];
  browseFile: [void, string | null];
  importEnv: [void, { uri: string; password: string; name: string } | null];
  guessEnvironment: [{ name: string; uri: string }, string];
}

export interface PlaygroundBlock {
  id: number;
  kind: 'result' | 'print' | 'error';
  label?: string;
  line?: number;
  value?: Wire;
  docs?: WireDoc[];
  truncated?: boolean;
  text?: string;
  ms?: number;
}

export type PlaygroundEvent =
  | { name: 'start'; title: string; target: string; environment: string }
  | { name: 'block'; block: PlaygroundBlock }
  | { name: 'finish'; ms: number; status: 'done' | 'error' | 'cancelled' };

export interface PlaygroundApi {
  ready: [void, void];
  copyText: [{ text: string; label?: string }, void];
  cancel: [void, void];
  exportBlock: [{ id: number; format: 'json' | 'csv' }, void];
}

export interface RpcRequest { type: 'req'; id: number; method: string; params: unknown }
export interface RpcResponse { type: 'res'; id: number; result?: unknown; error?: RpcError }
export interface RpcEvent { type: 'event'; event: unknown }

export interface RpcError {
  message: string;
  /** Which query field failed, when known. */
  field?: 'filter' | 'sort' | 'project' | 'limit' | 'keys' | 'partial' | 'update' | 'value' | 'pipeline';
  line?: number;
  col?: number;
  cancelled?: boolean;
  stage?: number;
}

export type ApiMethods<A> = keyof A & string;
