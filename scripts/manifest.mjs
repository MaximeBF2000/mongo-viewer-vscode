// Generates the `contributes` section of package.json from a compact table, so
// commands, menus and keybindings stay readable. Run with: node scripts/manifest.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const C = 'Mongo Viewer';
const commands = [
  // id, title, icon
  ['addConnection', 'Add Connection', 'add'],
  ['importFromEnv', 'Import Connection from .env File', 'file-symlink-file'],
  ['filterTree', 'Filter Databases and Collections', 'filter'],
  ['clearTreeFilter', 'Clear Filter', 'clear-all'],
  ['refreshAll', 'Refresh', 'refresh'],
  ['goToCollection', 'Go to Collection…', 'search'],
  ['newPlayground', 'New Query Playground', 'notebook'],
  ['connect', 'Connect', 'plug'],
  ['disconnect', 'Disconnect', 'debug-disconnect'],
  ['reconnect', 'Reconnect', 'debug-restart'],
  ['editConnection', 'Edit Connection…', 'edit'],
  ['removeConnection', 'Remove Connection', 'trash'],
  ['copyConnectionString', 'Copy Connection String', 'copy'],
  ['openShell', 'Open mongosh', 'terminal'],
  ['refreshNode', 'Refresh', 'refresh'],
  ['createDatabase', 'Create Database…', 'add'],
  ['dropDatabase', 'Drop Database…', 'trash'],
  ['createCollection', 'Create Collection…', 'add'],
  ['dropCollection', 'Drop Collection…', 'trash'],
  ['renameCollection', 'Rename Collection…', 'edit'],
  ['copyCollection', 'Copy Collection To…', 'files'],
  ['openCollection', 'Open Collection', 'table'],
  ['openSchema', 'View Schema', 'symbol-structure'],
  ['openIndexes', 'View Indexes', 'list-tree'],
  ['openStats', 'View Statistics', 'graph'],
  ['openAggregation', 'Build Aggregation', 'layers'],
  ['insertDocument', 'Insert Document', 'add'],
  ['importDocuments', 'Import Documents…', 'cloud-upload'],
  ['exportCollection', 'Export Collection…', 'cloud-download'],
  ['pinCollection', 'Add to Favorites', 'star-empty'],
  ['unpinCollection', 'Remove from Favorites', 'star-full'],
  ['clearRecent', 'Clear Recent Collections', 'clear-all'],
  ['copyName', 'Copy Name', 'copy'],
  ['runPlayground', 'Run Playground (or Selection)', 'play'],
  ['runStatement', 'Run Statement', 'play'],
  ['cancelPlayground', 'Cancel Playground Run', 'debug-stop'],
  ['choosePlaygroundTarget', 'Choose Playground Connection and Database', 'database'],
  ['compareWithDatabase', 'Compare with Database', 'diff'],
  ['deleteOpenDocument', 'Delete This Document', 'trash'],
  ['duplicateOpenDocument', 'Duplicate This Document', 'files'],
  ['chooseAiModel', 'Choose AI Model', 'sparkle'],
  ['showLogs', 'Show Logs', 'output'],
];

const hiddenFromPalette = new Set([
  'connect', 'disconnect', 'reconnect', 'editConnection', 'removeConnection', 'copyConnectionString',
  'refreshNode', 'dropDatabase', 'createCollection', 'dropCollection', 'renameCollection', 'copyCollection',
  'openCollection', 'openSchema', 'openIndexes', 'openStats', 'openAggregation', 'insertDocument',
  'importDocuments', 'exportCollection', 'pinCollection', 'unpinCollection', 'copyName', 'runStatement',
  'createDatabase', 'clearTreeFilter', 'clearRecent', 'deleteOpenDocument', 'duplicateOpenDocument',
  'compareWithDatabase', 'runPlayground', 'cancelPlayground', 'choosePlaygroundTarget',
]);

const id = (s) => `mongoViewer.${s}`;
const view = 'view == mongoViewer.connections';
const anyView = '(view == mongoViewer.connections || view == mongoViewer.favorites)';
const item = (re) => `viewItem =~ /${re}/`;

const treeMenu = (cmd, when, group) => ({ command: id(cmd), when, group });
const CONN = 'connection';
const CONN_ON = 'connection\\.connected';
const CONN_OFF = 'connection\\.disconnected';
const DB = '^database';
const DB_RW = '^database\\.rw';
const COLL = '^collection';
const COLL_RW = '^collection\\.[a-z]+\\.rw';
const COLL_DOCS = '^collection\\.(collection|timeseries)\\.rw';

const viewItemContext = [
  treeMenu('connect', `${view} && ${item(CONN_OFF)}`, '1_conn@1'),
  treeMenu('disconnect', `${view} && ${item(CONN_ON)}`, '1_conn@2'),
  treeMenu('reconnect', `${view} && ${item(CONN_ON)}`, '1_conn@3'),
  treeMenu('openShell', `${view} && ${item(`${CONN}|${DB}|${COLL}`)}`, '2_tools@1'),
  treeMenu('newPlayground', `${view} && ${item(`${CONN}|${DB}|${COLL}`)}`, '2_tools@2'),
  treeMenu('createDatabase', `${view} && ${item('connection\\.connected\\.rw')}`, '3_create@1'),
  treeMenu('createCollection', `${view} && ${item(DB_RW)}`, '3_create@2'),
  treeMenu('refreshNode', `${view} && ${item(`${CONN_ON}|${DB}`)}`, '4_refresh@1'),
  treeMenu('editConnection', `${view} && ${item(CONN)}`, '5_manage@1'),
  treeMenu('copyConnectionString', `${view} && ${item(CONN)}`, '5_manage@2'),
  treeMenu('removeConnection', `${view} && ${item(CONN)}`, '5_manage@3'),

  treeMenu('openCollection', `${anyView} && ${item(COLL)}`, '1_open@1'),
  treeMenu('openSchema', `${anyView} && ${item(COLL)}`, '1_open@2'),
  treeMenu('openIndexes', `${anyView} && ${item(COLL)}`, '1_open@3'),
  treeMenu('openAggregation', `${anyView} && ${item(COLL)}`, '1_open@4'),
  treeMenu('openStats', `${anyView} && ${item(COLL)}`, '1_open@5'),
  treeMenu('insertDocument', `${anyView} && ${item(COLL_DOCS)}`, '3_data@1'),
  treeMenu('importDocuments', `${anyView} && ${item(COLL_DOCS)}`, '3_data@2'),
  treeMenu('exportCollection', `${anyView} && ${item(COLL)}`, '3_data@3'),
  treeMenu('copyCollection', `${anyView} && ${item(COLL)}`, '3_data@4'),
  treeMenu('pinCollection', `${anyView} && ${item('^collection.*\\.unpinned')}`, '4_fav@1'),
  treeMenu('unpinCollection', `${anyView} && ${item('^collection.*\\.pinned')}`, '4_fav@1'),
  treeMenu('copyName', `${anyView} && ${item(`${DB}|${COLL}`)}`, '5_copy@1'),
  treeMenu('renameCollection', `${view} && ${item(COLL_RW)}`, '6_danger@1'),
  treeMenu('dropCollection', `${view} && ${item(COLL_RW)}`, '6_danger@2'),
  treeMenu('dropDatabase', `${view} && ${item(DB_RW)}`, '6_danger@3'),

  // Inline hover actions
  treeMenu('openShell', `${view} && ${item(CONN_ON)}`, 'inline@1'),
  treeMenu('createCollection', `${view} && ${item(DB_RW)}`, 'inline@1'),
  treeMenu('pinCollection', `${anyView} && ${item('^collection.*\\.unpinned')}`, 'inline@2'),
  treeMenu('unpinCollection', `${anyView} && ${item('^collection.*\\.pinned')}`, 'inline@2'),
  treeMenu('openSchema', `${anyView} && ${item(COLL)}`, 'inline@1'),
];

const manifest = {
  viewsContainers: {
    activitybar: [{ id: 'mongoViewer', title: C, icon: 'media/activity.svg' }],
  },
  views: {
    mongoViewer: [
      { id: 'mongoViewer.connections', name: 'Connections', icon: 'media/activity.svg', contextualTitle: C },
      { id: 'mongoViewer.favorites', name: 'Favorites & Recent', icon: 'media/activity.svg', contextualTitle: C, visibility: 'collapsed' },
    ],
  },
  viewsWelcome: [
    {
      view: 'mongoViewer.connections',
      contents:
        'Connect to MongoDB to browse and query your data.\n[Add Connection](command:mongoViewer.addConnection)\n[Import from .env File](command:mongoViewer.importFromEnv)\nAtlas, self-hosted and localhost are all supported. Credentials stay in VS Code SecretStorage.',
    },
  ],
  commands: commands.map(([cmd, title, icon]) => ({
    command: id(cmd),
    title,
    category: C,
    icon: `$(${icon})`,
  })),
  menus: {
    commandPalette: [
      ...[...hiddenFromPalette].map((c) => ({ command: id(c), when: 'false' })),
      { command: id('runPlayground'), when: 'editorLangId == mongoplayground' },
      { command: id('cancelPlayground'), when: 'mongoViewer.playgroundRunning' },
      { command: id('choosePlaygroundTarget'), when: 'editorLangId == mongoplayground' },
      { command: id('compareWithDatabase'), when: 'resourceScheme == mongoviewer-doc' },
      { command: id('deleteOpenDocument'), when: 'resourceScheme == mongoviewer-doc' },
      { command: id('duplicateOpenDocument'), when: 'resourceScheme == mongoviewer-doc' },
    ].filter((v, i, a) => {
      // Entries that carry a real `when` replace the blanket hide above.
      const later = a.findLastIndex((x) => x.command === v.command);
      return later === i;
    }),
    'view/title': [
      { command: id('addConnection'), when: view, group: 'navigation@1' },
      { command: id('newPlayground'), when: view, group: 'navigation@2' },
      { command: id('filterTree'), when: `${view} && !mongoViewer.filterActive`, group: 'navigation@3' },
      { command: id('clearTreeFilter'), when: `${view} && mongoViewer.filterActive`, group: 'navigation@3' },
      { command: id('refreshAll'), when: view, group: 'navigation@4' },
      { command: id('goToCollection'), when: view, group: '1_tools@1' },
      { command: id('importFromEnv'), when: view, group: '1_tools@2' },
      { command: id('showLogs'), when: view, group: '2_misc@1' },
      { command: id('clearRecent'), when: 'view == mongoViewer.favorites', group: 'navigation@1' },
    ],
    'view/item/context': viewItemContext,
    'editor/title': [
      { command: id('runPlayground'), when: 'editorLangId == mongoplayground && !mongoViewer.playgroundRunning', group: 'navigation@1' },
      { command: id('cancelPlayground'), when: 'editorLangId == mongoplayground && mongoViewer.playgroundRunning', group: 'navigation@1' },
      { command: id('choosePlaygroundTarget'), when: 'editorLangId == mongoplayground', group: 'navigation@2' },
      { command: id('compareWithDatabase'), when: 'resourceScheme == mongoviewer-doc', group: 'navigation@1' },
      { command: id('duplicateOpenDocument'), when: 'resourceScheme == mongoviewer-doc', group: 'navigation@2' },
      { command: id('deleteOpenDocument'), when: 'resourceScheme == mongoviewer-doc', group: 'navigation@3' },
    ],
  },
  keybindings: [
    { command: id('runPlayground'), key: 'ctrl+enter', mac: 'cmd+enter', when: 'editorLangId == mongoplayground' },
    { command: id('goToCollection'), key: 'ctrl+alt+m', mac: 'cmd+alt+m' },
  ],
  languages: [
    {
      id: 'mongoplayground',
      aliases: ['MongoDB Playground'],
      extensions: ['.mongo.js'],
      configuration: './syntaxes/language-configuration.json',
      icon: { light: 'media/file.svg', dark: 'media/file.svg' },
    },
    {
      id: 'mongodoc',
      aliases: ['MongoDB Document'],
      extensions: ['.mongodoc'],
      configuration: './syntaxes/language-configuration.json',
      icon: { light: 'media/file.svg', dark: 'media/file.svg' },
    },
  ],
  grammars: [
    { language: 'mongoplayground', scopeName: 'source.mongoplayground', path: './syntaxes/mongoplayground.tmLanguage.json' },
    { language: 'mongodoc', scopeName: 'source.mongodoc', path: './syntaxes/mongodoc.tmLanguage.json' },
  ],
  snippets: [{ language: 'mongoplayground', path: './snippets/playground.json' }],
  colors: [
    { id: 'mongoViewer.production', description: 'Color that identifies production connections.', defaults: { dark: '#f14c4c', light: '#c72e2e', highContrast: '#f14c4c' } },
    { id: 'mongoViewer.connected', description: 'Color of a connected connection.', defaults: { dark: '#3fb950', light: '#1a7f37', highContrast: '#3fb950' } },
  ],
  // Saving a document writes to the database, so it must always be a deliberate action.
  configurationDefaults: {
    '[mongodoc]': { 'files.autoSave': 'off', 'editor.formatOnSave': false },
  },
  configuration: {
    title: C,
    properties: {
      'mongoViewer.defaultPageSize': { type: 'number', enum: [20, 50, 100], default: 20, description: 'Documents per page in the collection viewer.' },
      'mongoViewer.defaultView': { type: 'string', enum: ['table', 'json', 'tree'], default: 'table', description: 'Display mode for newly opened collections.' },
      'mongoViewer.queryTimeoutMs': { type: 'number', default: 30000, minimum: 1000, description: 'Server-side time limit (maxTimeMS) applied to queries from the collection viewer.' },
      'mongoViewer.countTimeoutMs': { type: 'number', default: 3000, minimum: 100, description: 'Time limit for filtered counts. Counts that exceed it are skipped rather than blocking the viewer.' },
      'mongoViewer.connectTimeoutMs': { type: 'number', default: 8000, minimum: 500, description: 'How long to wait for a server when connecting.' },
      'mongoViewer.schemaSampleSize': { type: 'number', default: 500, minimum: 10, maximum: 10000, description: 'Number of documents sampled by the schema viewer.' },
      'mongoViewer.showSystemCollections': { type: 'boolean', default: false, description: 'Show system.* collections in the sidebar.' },
      'mongoViewer.confirmProductionWrites': { type: 'boolean', default: true, description: 'Ask for confirmation before any write to a connection marked as production.' },
      'mongoViewer.mongoshPath': { type: 'string', default: '', description: 'Path to the mongosh executable. Leave empty to find it on your PATH.' },
      'mongoViewer.playground.resultLimit': { type: 'number', default: 100, minimum: 1, description: 'Maximum documents shown for each cursor result in a playground.' },
      'mongoViewer.playground.timeoutMs': { type: 'number', default: 300000, minimum: 1000, description: 'A playground run is stopped after this time.' },
      'mongoViewer.ai.enabled': { type: 'boolean', default: true, description: 'Show natural-language search in the query bar.' },
      'mongoViewer.ai.endpoint': { type: 'string', default: 'http://localhost:11434', description: 'Base URL of the Ollama server.' },
      'mongoViewer.ai.model': { type: 'string', default: 'qwen3.5:4b', markdownDescription: 'Ollama model used for natural-language search. Any installed model name works, or use the **Mongo Viewer: Choose AI Model** command. If it is not installed, the smallest installed Qwen model is used.' },
      'mongoViewer.ai.includeSampleValues': { type: 'boolean', default: true, description: 'Include short example values in the prompt. They are only ever sent to a local endpoint (localhost).' },
      'mongoViewer.ai.autoRun': { type: 'boolean', default: false, description: 'Run generated queries immediately instead of waiting for you to press Run.' },
    },
  },
};

pkg.main = './dist/extension.js';
pkg.icon = 'media/icon.png';
pkg.categories = ['Other', 'Visualization'];
pkg.keywords = ['mongodb', 'mongo', 'database', 'nosql', 'atlas', 'mongosh', 'query'];
pkg.publisher = 'maximebf';
pkg.activationEvents = ['onFileSystem:mongoviewer-doc', 'onLanguage:mongoplayground', 'onWebviewPanel:mongoViewer.collection'];
pkg.capabilities = { untrustedWorkspaces: { supported: 'limited', description: 'Playground scripts cannot run in untrusted workspaces.' } };
pkg.contributes = manifest;
pkg.scripts = {
  manifest: 'node scripts/manifest.mjs',
  build: 'node scripts/build.mjs',
  watch: 'node scripts/build.mjs --watch',
  typecheck: 'tsc --noEmit && tsc --noEmit -p src/webview',
  test: 'vitest run',
  e2e: 'node test/e2e/run.mjs',
  package: 'npm run manifest && npm run typecheck && node scripts/build.mjs --production && vsce package --no-dependencies --skip-license --allow-missing-repository',
  'vscode:prepublish': 'node scripts/build.mjs --production',
};
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`manifest: ${commands.length} commands`);
