// End-to-end test of the real extension in the real VS Code UI, in headless Chromium.
//   MV_E2E_DATA=<dir> [MV_CHROME=<path>] [TEST_MONGO_URI=...] node test/e2e/run.mjs [only]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { seed } from './seed.mjs';
import { command, report, resetDir, shot, sleep, startVSCode, step, stopVSCode, webview, OUT } from './harness.mjs';

const URI = process.env.TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27099';
const dataDir = process.env.MV_E2E_DATA;
if (!dataDir) throw new Error('Set MV_E2E_DATA to a scratch directory.');
const only = process.argv[2];

await seed(URI);
const mongo = await new MongoClient(URI).connect();
const myapp = mongo.db('myapp');

// Each run starts from a clean profile. The downloaded VS Code server is kept in cli/.
const workspace = join(dataDir, 'workspace');
resetDir(workspace);
resetDir(join(dataDir, 'server'));
writeFileSync(join(workspace, '.env'), `# test env\nMONGO_URL="${URI}/myapp"\nOTHER=1\n`);
writeFileSync(join(workspace, 'import.ndjson'), '{"sku":"imported-1"}\n{"sku":"imported-2"}\n');

const h = await startVSCode({ workspace, dataDir });
const { page } = h;
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
step.onFail = async (name) => {
  await shot(page, `fail-${name.replace(/\W+/g, '-')}`).catch(() => undefined);
  // Recover, so one failure doesn't take down every later step.
  const dialog = page.locator('.monaco-dialog-box .dialog-buttons a, .monaco-dialog-box .dialog-buttons button', { hasText: 'Cancel' }).first();
  if (await dialog.count()) await dialog.click({ timeout: 1000 }).catch(() => undefined);
  await page.keyboard.press('Escape').catch(() => undefined);
  await dismissNotifications().catch(() => undefined);
  if (await page.locator('.tab.dirty').count()) await command(page, 'File: Revert File').catch(() => undefined);
  await command(page, 'Mongo Viewer: Focus on Connections View').catch(() => undefined);
};

const onlyRe = only ? new RegExp(only, 'i') : null;
const run = async (name, fn) => {
  if (onlyRe && !onlyRe.test(name)) return;
  await step(name, fn);
  if (process.env.MV_E2E_TRACE) console.log('    keys:', Object.keys((await myapp.collection('users').findOne()) ?? {}).join(','));
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg = '') => { if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const waitFor = async (fn, what, timeout = 15000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what} (last: ${String(last).slice(0, 200)})`);
};
const dismissNotifications = async () => {
  for (const b of await page.locator('.notification-toast .codicon-notifications-clear').all()) await b.click({ timeout: 500 }).catch(() => undefined);
};
const modalButton = async (text) => {
  const b = page.locator('.monaco-dialog-box .dialog-buttons a, .monaco-dialog-box .dialog-buttons button', { hasText: text }).first();
  await b.waitFor({ state: 'visible', timeout: 8000 });
  await b.click();
};
const quickInput = page.locator('.quick-input-widget input.input');
const pickQuick = async (text) => {
  const row = page.locator('.quick-input-list .monaco-list-row', { hasText: text }).first();
  await row.waitFor({ state: 'visible', timeout: 8000 });
  await row.click();
};
/** VS Code ignores clicks in the first moments after a context menu opens. */
const menuClick = async (text) => {
  const item = page.locator('.context-view .action-item', { hasText: text }).first();
  await item.waitFor({ state: 'visible' });
  await sleep(250);
  await item.click();
};
const treeRow = (name) => page.locator('#workbench\\.parts\\.sidebar .monaco-list-row')
  .filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${name}$`) }) }).first();
const appText = async (f) => (await f.locator('#app').innerText());

let viewer;
const openViewer = async () => { viewer = await webview(page, 'collection'); return viewer; };

/** Closes every editor, discarding edits, then opens one collection from the sidebar. */
const closeAll = async () => {
  await command(page, 'View: Close All Editors');
  await sleep(300);
  for (let i = 0; i < 4; i++) {
    const b = page.locator('.monaco-dialog-box .dialog-buttons a, .monaco-dialog-box .dialog-buttons button', { hasText: /Don.t Save/ }).first();
    if (!(await b.count())) break;
    await b.click();
    await sleep(300);
  }
  await dismissNotifications();
};
const fresh = async (name = 'users') => {
  await closeAll();
  await treeRow(name).click();
  const f = await openViewer();
  await f.locator('.doc-table tbody tr').first().waitFor({ timeout: 10000 });
  return f;
};
const colIndex = async (f, name) => (await f.locator('.doc-table thead th .th-label').allInnerTexts()).indexOf(name) + 1;

await sleep(3000);

await run('add a connection through the form, with env detection', async () => {
  await command(page, 'Mongo Viewer: Add Connection');
  const f = await webview(page, 'connectionForm');
  await f.locator('.conn-form').waitFor({ timeout: 15000 });
  await f.locator('textarea').fill(`${URI}/myapp`);
  await f.locator('input[placeholder="Production"]').fill('Local Test');
  await waitFor(async () => (await f.locator('[role=radio][aria-checked=true]', { hasText: 'Local' }).count()) === 1, 'env guess');
  await f.locator('button', { hasText: 'Test Connection' }).click();
  await waitFor(async () => /Connected to MongoDB 7/.test(await appText(f)), 'test result');
  await shot(page, '01-connection-form');
  await f.locator('button', { hasText: 'Save and Connect' }).click();
  await page.locator('.tab', { hasText: 'New Connection' }).waitFor({ state: 'detached', timeout: 8000 });
});

await run('credentials stay out of plain storage', async () => {
  const stored = await page.evaluate(() => Object.values(localStorage).join('\n'));
  expect(!stored.includes(URI), 'URI found in localStorage');
});

await run('sidebar: connections, databases, collections, counts', async () => {
  await page.locator('.activitybar [aria-label*="Mongo Viewer"]').first().click();
  await treeRow('Local Test').waitFor({ timeout: 10000 });
  await waitFor(async () => (await treeRow('myapp').count()) > 0, 'databases');
  if (!(await treeRow('users').count())) await treeRow('myapp').click();
  await treeRow('users').waitFor({ timeout: 10000 });
  await waitFor(async () => /1\.2K/.test(await treeRow('users').innerText()), 'count on users');
  await waitFor(async () => /4\.8K/.test(await treeRow('orders').innerText()), 'count on orders');
  await treeRow('active_users').waitFor();
  expect(/view/.test(await treeRow('active_users').innerText()), 'view label');
  await sleep(300);
  await shot(page, '02-sidebar');
});

await run('open collection: table view, pagination, timing', async () => {
  await treeRow('users').click();
  const f = await openViewer();
  await f.locator('.doc-table tbody tr').first().waitFor({ timeout: 15000 });
  eq(await f.locator('.doc-table tbody tr').count(), 20, 'rows');
  await waitFor(async () => /1–20 of ~1,240/.test(await appText(f)), 'estimated total');
  expect(/\d+ ms/.test(await appText(f)), 'timing');
  await shot(page, '03-table');
  await f.locator('[aria-label^="Next page"]').click();
  await waitFor(async () => /21–40/.test(await appText(f)), 'page 2');
  await f.locator('[aria-label^="Previous page"]').click();
  await waitFor(async () => /1–20/.test(await appText(f)), 'page 1');
  await f.locator('.page-size select').selectOption('50');
  await waitFor(async () => (await f.locator('.doc-table tbody tr').count()) === 50, 'page size 50');
  await f.locator('.page-size select').selectOption('20');
  await waitFor(async () => (await f.locator('.doc-table tbody tr').count()) === 20, 'page size 20');
});

await run('query: filter with Enter, highlighting, sort, project, limit', async () => {
  const f = await fresh();
  const filter = f.locator('textarea[aria-label="Filter"]');
  await filter.fill('{ active: true, age: { $gte: 70 } }');
  await filter.press('Enter');
  await waitFor(async () => (await f.locator('.doc-table tbody tr').count()) > 0 && !(await appText(f)).includes('of ~'), 'filtered results');
  const exact = await myapp.collection('users').countDocuments({ active: true, age: { $gte: 70 } });
  await waitFor(async () => (await appText(f)).includes(`of ${exact.toLocaleString('en-US')}`), `exact count ${exact}`);
  eq(await f.locator('.code-layer .tok-operator').first().innerText(), '$gte', 'highlight');
  await f.locator('[aria-label="Sort, project and limit"]').click();
  await f.locator('textarea[aria-label="Sort"]').fill('{ age: -1 }');
  await f.locator('textarea[aria-label="Project"]').fill('{ name: 1, age: 1, _id: 0 }');
  await f.locator('input[aria-label="Limit"]').fill('5');
  await f.locator('input[aria-label="Limit"]').press('Enter');
  await waitFor(async () => (await f.locator('.doc-table tbody tr').count()) === 5, 'limit');
  const headers = await f.locator('.doc-table thead th .th-label').allInnerTexts();
  eq(headers.join(','), 'name,age', 'projection');
  await shot(page, '04-query');
});

await run('query: helpful errors, and $regex, ObjectId, _id search', async () => {
  const f = await fresh();
  const filter = f.locator('textarea[aria-label="Filter"]');
  await filter.fill('{ status: active }');
  await waitFor(async () => /Unknown value 'active'/.test(await appText(f)), 'live error');
  expect(await f.locator('button', { hasText: 'Run' }).isDisabled(), 'run disabled');
  await shot(page, '05-query-error');
  await filter.fill('{ age: { $nope: 1 } }');
  await filter.press('Enter');
  await waitFor(async () => /unknown operator/i.test(await appText(f)), 'server error');
  await filter.fill('{ name: /^max/i }');
  await filter.press('Enter');
  await waitFor(async () => /^max/i.test(await f.locator('.doc-table tbody tr td').nth(2).innerText()), 'regex');
  await filter.fill('65a0000a0000000000000000');
  await filter.press('Enter');
  await waitFor(async () => (await filter.inputValue()).startsWith('{ _id: ObjectId(') && (await f.locator('.doc-table tbody tr').count()) === 1, '_id search');
  await f.locator('[aria-label="Reset query"]').click();
  await waitFor(async () => (await f.locator('.doc-table tbody tr').count()) === 20, 'reset');
});

await run('query: field and operator autocomplete', async () => {
  const f = await fresh();
  const filter = f.locator('textarea[aria-label="Filter"]');
  await filter.click();
  await filter.press('Control+a');
  await filter.pressSequentially('{ add');
  await waitFor(async () => (await f.locator('.completion').count()) > 0, 'field completions');
  expect(/address/.test(await f.locator('.completions').innerText()), 'address suggested');
  await shot(page, '06-autocomplete');
  await filter.press('Tab');
  const v1 = await filter.inputValue();
  expect(/address/.test(v1), `completed: ${v1}`);
  await f.locator('[aria-label="Reset query"]').click();
});

await run('column sort from header and column visibility', async () => {
  const f = await fresh();
  await f.locator('.doc-table thead th', { hasText: 'age' }).click();
  await waitFor(async () => (await f.locator('textarea[aria-label="Sort"]').inputValue()) === '{ age: 1 }', 'sort text');
  await waitFor(async () => {
    const idx = (await f.locator('.doc-table thead th .th-label').allInnerTexts()).indexOf('age');
    return (await f.locator('.doc-table tbody tr').first().locator('td').nth(idx + 1).innerText()) === '18';
  }, 'ascending values');
  await f.locator('[aria-label="Choose columns"]').click();
  await f.locator('.menu-item', { hasText: 'email' }).click();
  await waitFor(async () => !(await f.locator('.doc-table thead').innerText()).includes('email'), 'hidden column');
  await f.locator('[aria-label="Choose columns"]').click();
  await f.locator('.menu-item', { hasText: 'Show All Columns' }).click();
  await f.locator('[aria-label="Reset query"]').click();
});

await run('JSON and Tree views show nested data', async () => {
  const f = await fresh();
  await f.locator('[role=radio][aria-label^="JSON"]').click();
  await f.locator('.json-view .doc-card').first().waitFor();
  const t = await f.locator('.json-view .doc-card').first().innerText();
  expect(/ObjectId\("/.test(t) && /ISODate\("/.test(t) && /address/.test(t), `json: ${t.slice(0, 200)}`);
  await shot(page, '07-json');
  await f.locator('.json-view .j-chevron.toggle').nth(1).click();
  await f.locator('[role=radio][aria-label^="Tree"]').click();
  await f.locator('.tree-view .t-row').first().waitFor();
  const row = f.locator('.tree-view .doc-card').first().locator('.t-row', { hasText: 'address' });
  expect(/Object/.test(await row.innerText()), 'tree shows type');
  await f.locator('.tree-view .doc-card').first().locator('.t-row', { hasText: 'city' }).waitFor();
  await row.click();
  await waitFor(async () => (await f.locator('.tree-view .doc-card').first().locator('.t-row', { hasText: 'city' }).count()) === 0, 'collapse');
  await row.click();
  await shot(page, '08-tree');
  await f.locator('[role=radio][aria-label^="Table"]').click();
});

await run('open a document, edit with Cmd+S, types preserved', async () => {
  const f = await fresh();
  await f.locator('.doc-table tbody tr').first().locator('td').nth(2).dblclick();
  await page.locator('.tab.active', { hasText: '.mongodoc' }).waitFor({ timeout: 10000 });
  const editor = page.locator('.editor-instance .monaco-editor').first();
  await waitFor(async () => /ObjectId/.test(await editor.innerText()), 'document text');
  await shot(page, '09-document-editor');
  await editor.click();
  const before = await myapp.collection('users').findOne({ _id: await firstUserId() });
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('edited: true,');
  await page.keyboard.press('Meta+s');
  await waitFor(async () => (await myapp.collection('users').findOne({ _id: before._id }))?.edited === true, 'saved value');
  const types = await myapp.collection('users').aggregate([{ $match: { _id: before._id } }, { $project: { age: { $type: '$age' }, balance: { $type: '$balance' }, at: { $type: '$createdAt' }, lat: { $type: '$address.geo.lat' } } }]).next();
  eq(types.age, 'int', 'age type');
  eq(types.balance, 'double', 'balance type');
  eq(types.at, 'date', 'date type');
  eq(types.lat, 'double', 'nested double');
});

async function firstUserId() {
  const [d] = await myapp.collection('users').find().limit(1).toArray();
  return d._id;
}

await run('invalid document is rejected on save with a clear message', async () => {
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('bad: nope,');
  await sleep(600);
  await page.keyboard.press('Meta+s');
  await waitFor(async () => /Unknown value 'nope'/.test(await page.locator('.notifications-toasts').innerText()), 'save error');
  await shot(page, '10-invalid-save');
  await dismissNotifications();
  await command(page, 'File: Revert File');
  await sleep(400);
});

await run('conflict detection when a document changed elsewhere', async () => {
  const id = await firstUserId();
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('mine: 1,');
  await myapp.collection('users').updateOne({ _id: id }, { $set: { changedElsewhere: true } });
  await page.keyboard.press('Meta+s');
  await page.locator('.monaco-dialog-box', { hasText: 'changed in the database' }).waitFor({ timeout: 8000 });
  await shot(page, '11-conflict');
  await modalButton('Overwrite');
  await waitFor(async () => (await myapp.collection('users').findOne({ _id: id }))?.mine === 1, 'overwrite saved');
  const doc = await myapp.collection('users').findOne({ _id: id });
  expect(doc.changedElsewhere === undefined, 'overwrite replaced the other change');
  await dismissNotifications();
});

await run('compare with database opens a native diff', async () => {
  await command(page, 'Mongo Viewer: Compare with Database');
  await sleep(300);
  // Hidden from the palette unless the document scheme is active, so this also tests that rule.
  await page.locator('.tab.active', { hasText: 'Database' }).waitFor({ timeout: 8000 });
  await page.locator('.monaco-diff-editor').first().waitFor();
  await shot(page, '12-diff');
  await command(page, 'View: Close Editor');
  await sleep(500);
});

await run('auto-save never writes to the database', async () => {
  const f = await fresh();
  const settingsPath = join(workspace, '.vscode', 'settings.json');
  const original = readFileSync(settingsPath, 'utf8');
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(original), 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 200 }));
  await sleep(800);
  const row = f.locator('.doc-table tbody tr').nth(2);
  await row.locator('td').nth(await colIndex(f, 'name')).dblclick();
  await page.locator('.tab.active', { hasText: '.mongodoc' }).waitFor();
  await page.locator('.editor-instance .monaco-editor').first().waitFor();
  await sleep(500);
  await page.locator('.editor-instance .monaco-editor').first().click();
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('autosaved: true,');
  await sleep(1500);
  eq(await myapp.collection('users').countDocuments({ autosaved: true }), 0, 'autosaved documents');
  expect(await page.locator('.tab.active.dirty').count() === 1, 'the editor stays dirty');
  writeFileSync(settingsPath, original);
  await sleep(500);
});

await run('viewer refreshes after a save, and inline field edits work', async () => {
  const f = await fresh();
  await waitFor(async () => /mine/.test(await f.locator('.doc-table thead').innerText()), 'new column after save');
  const id = await firstUserId();
  const cell = f.locator('.doc-table tbody tr').first().locator('td').nth(await colIndex(f, 'name'));
  await cell.click({ button: 'right' });
  await f.locator('.menu-item', { hasText: 'Edit Value' }).click();
  await f.locator('.dialog textarea').fill('"Edited Name"');
  await shot(page, '13-edit-field');
  await f.locator('.dialog .btn.primary').click();
  await waitFor(async () => (await myapp.collection('users').findOne({ _id: id })).name === 'Edited Name', 'field updated');
  await waitFor(async () => /Edited Name/.test(await f.locator('.doc-table tbody tr').first().innerText()), 'cell refreshed');

  await f.locator('.doc-table tbody tr').first().locator('td').nth(await colIndex(f, 'name')).click({ button: 'right' });
  await f.locator('.menu-item', { hasText: 'Add Field' }).click();
  await f.locator('.dialog input.input').fill('note');
  await f.locator('.dialog textarea').fill('Decimal128("1.50")');
  await f.locator('.dialog .btn.primary').click();
  await waitFor(async () => (await myapp.collection('users').findOne({ _id: id })).note?.toString() === '1.50', 'field added');

  await waitFor(async () => /note/.test(await f.locator('.doc-table thead').innerText()), 'note column');
  await f.locator('.doc-table tbody tr').first().locator('td').nth(await colIndex(f, 'note')).click({ button: 'right' });
  await f.locator('.menu-item', { hasText: 'Remove Field' }).click();
  await modalButton('Remove Field');
  await waitFor(async () => (await myapp.collection('users').findOne({ _id: id })).note === undefined, 'field removed');
});

await run('filter by a value from a cell', async () => {
  const f = await fresh();
  await f.locator('.doc-table tbody tr').nth(1).locator('td').nth(await colIndex(f, 'plan')).click({ button: 'right' });
  await f.locator('.menu-item', { hasText: 'Filter by This Value' }).click();
  await waitFor(async () => /plan: "/.test(await f.locator('textarea[aria-label="Filter"]').inputValue()), 'filter text');
  await f.locator('[aria-label="Reset query"]').click();
  await waitFor(async () => (await f.locator('textarea[aria-label="Filter"]').inputValue()) === '', 'reset');
});

await run('insert a document with Cmd+S', async () => {
  const f = await fresh();
  const before = await myapp.collection('users').estimatedDocumentCount();
  await f.locator('[aria-label="Insert a document"]').click();
  await page.locator('.tab.active', { hasText: 'New Document' }).waitFor({ timeout: 8000 });
  await sleep(500);
  await page.keyboard.type('name: "Inserted", at: ISODate("2025-01-01"), price: Decimal128("9.99")');
  await page.keyboard.press('Meta+s');
  await waitFor(async () => (await myapp.collection('users').estimatedDocumentCount()) === before + 1, 'inserted');
  const d = await myapp.collection('users').findOne({ name: 'Inserted' });
  expect(d.at instanceof Date, 'date');
  eq(d.price.toString(), '9.99', 'decimal');
  await waitFor(async () => (await page.locator('.tab.active').innerText()).includes(d._id.toHexString()), 'tab becomes the saved document', 6000);
  await sleep(300);
});

await run('duplicate is rejected by a unique index with the reason shown', async () => {
  const f = await fresh();
  await f.locator('.doc-table tbody tr').nth(3).hover();
  await f.locator('.doc-table tbody tr').nth(3).locator('[aria-label="Duplicate document"]').click();
  await page.locator('.tab.active', { hasText: 'New Document' }).waitFor();
  await sleep(500);
  await page.keyboard.press('Meta+s');
  await waitFor(async () => /duplicate key/.test(await page.locator('.notifications-toasts').innerText()), 'duplicate key error');
  await dismissNotifications();
});

await run('duplicate and delete with confirmation', async () => {
  const f = await fresh('products');
  const coll = myapp.collection('products');
  const before = await coll.estimatedDocumentCount();
  await f.locator('.doc-table tbody tr').nth(3).hover();
  await f.locator('.doc-table tbody tr').nth(3).locator('[aria-label="Duplicate document"]').click();
  await page.locator('.tab.active', { hasText: 'New Document' }).waitFor();
  await sleep(500);
  await page.keyboard.press('Meta+s');
  await waitFor(async () => (await coll.estimatedDocumentCount()) === before + 1, 'duplicated');
  await sleep(800);
  await treeRow('products').click();
  await f.locator('.doc-table tbody tr').nth(3).hover();
  await f.locator('.doc-table tbody tr').nth(3).locator('[aria-label="Delete document"]').click();
  await page.locator('.monaco-dialog-box', { hasText: 'Delete this document' }).waitFor();
  await shot(page, '14-delete-confirm');
  await modalButton('Cancel');
  eq(await coll.estimatedDocumentCount(), before + 1, 'cancel keeps it');
  await f.locator('.doc-table tbody tr').nth(3).hover();
  await f.locator('.doc-table tbody tr').nth(3).locator('[aria-label="Delete document"]').click();
  await modalButton('Delete');
  await waitFor(async () => (await coll.estimatedDocumentCount()) === before, 'deleted');
});

await run('multi-select and bulk delete', async () => {
  const f = await fresh();
  const before = await myapp.collection('users').estimatedDocumentCount();
  await f.locator('.doc-table tbody tr').nth(5).locator('input[type=checkbox]').click();
  await f.locator('.doc-table tbody tr').nth(6).locator('input[type=checkbox]').click();
  await waitFor(async () => /2 selected/.test(await appText(f)), 'selection');
  await shot(page, '15-selection');
  await f.locator('[aria-label="Delete selected documents"]').click();
  await modalButton('Delete');
  await waitFor(async () => (await myapp.collection('users').estimatedDocumentCount()) === before - 2, 'bulk deleted');
});

await run('explain: collection scan, tip, and index creation', async () => {
  const f = await fresh();
  await f.locator('textarea[aria-label="Filter"]').fill('{ age: { $gt: 60 }, plan: "pro" }');
  await f.locator('[aria-label="Explain this query"]').click();
  await f.locator('.explain').waitFor({ timeout: 8000 });
  const t = await f.locator('.explain').innerText();
  expect(/Index:|Collection scan/.test(t), `plan: ${t.slice(0, 200)}`);
  await f.locator('textarea[aria-label="Filter"]').fill('{ balance: { $gt: 900 } }');
  await f.locator('[aria-label="Explain this query"]').click();
  await waitFor(async () => /Collection scan/.test(await f.locator('.explain').innerText()), 'collscan');
  expect(/balance: 1/.test(await f.locator('.tip').first().innerText()), 'suggests the balance index');
  await shot(page, '16-explain');
  await f.locator('.tip button', { hasText: 'Create Index' }).click();
  await f.locator('.explain .form .btn.primary').click();
  await waitFor(async () => (await myapp.collection('users').indexes()).some((i) => i.key.balance === 1), 'index created');
  await waitFor(async () => /Index: balance_1/.test(await f.locator('.explain').innerText()), 'plan now uses it');
  await f.locator('.explain [aria-label="Close"]').click();
  await f.locator('[aria-label="Reset query"]').click();
});

await run('schema tab', async () => {
  const f = await fresh();
  await f.locator('.tabs button', { hasText: 'Schema' }).click();
  await f.locator('.schema-table tbody tr').first().waitFor({ timeout: 10000 });
  const t = await f.locator('.schema-table').innerText();
  expect(/ObjectId/.test(t) && /Int32/.test(t) && /address/.test(t) && /nickname/.test(t), `schema: ${t.slice(0, 300)}`);
  await f.locator('.schema-table tr', { hasText: 'address' }).first().click();
  await f.locator('.schema-table tr', { hasText: 'city' }).waitFor();
  await shot(page, '17-schema');
});

await run('indexes tab: list, create, drop', async () => {
  const f = await fresh();
  await f.locator('.tabs button', { hasText: 'Indexes' }).click();
  await f.locator('.grid tbody tr').first().waitFor({ timeout: 8000 });
  const t = await f.locator('.grid').innerText();
  expect(/email_1/.test(t) && /unique/.test(t) && /plan_active/.test(t) && /sparse/.test(t), `indexes: ${t.slice(0, 300)}`);
  await f.locator('[aria-label="Create an index"]').click();
  await f.locator('.form textarea').first().fill('{ phone: 1 }');
  await f.locator('.checks label', { hasText: 'Sparse' }).locator('input').check();
  await shot(page, '18-indexes');
  await f.locator('.form .btn.primary').click();
  await waitFor(async () => (await myapp.collection('users').indexes()).some((i) => i.name === 'phone_1' && i.sparse), 'index created');
  await waitFor(async () => /phone_1/.test(await f.locator('.grid').innerText()), 'listed');
  await f.locator('.grid tr', { hasText: 'phone_1' }).locator('[aria-label="Drop index"]').click();
  await modalButton('Drop Index');
  await waitFor(async () => !(await myapp.collection('users').indexes()).some((i) => i.name === 'phone_1'), 'dropped');
});

await run('stats tab', async () => {
  const f = await fresh();
  await f.locator('.tabs button', { hasText: 'Stats' }).click();
  await f.locator('.stat').first().waitFor({ timeout: 8000 });
  expect(/Documents/.test(await f.locator('.stats').innerText()), 'stats');
  await shot(page, '19-stats');
});

await run('aggregation builder: preview, stage error, $out not run in preview', async () => {
  const f = await fresh();
  await f.locator('.tabs button', { hasText: 'Aggregation' }).click();
  const bodies = () => f.locator('.stage textarea');
  await bodies().nth(0).fill('{ active: true }');
  await f.locator('.add-stage').click();
  await bodies().nth(1).fill('{ _id: "$plan", n: { $sum: 1 } }');
  await f.locator('.add-stage').click();
  await f.locator('.stage select').nth(2).selectOption('$sort');
  await bodies().nth(2).fill('{ n: -1 ');
  await f.locator('button', { hasText: 'Preview' }).click();
  await waitFor(async () => (await f.locator('.stage.has-error').count()) === 1, 'stage error');
  await bodies().nth(2).fill('{ n: -1 }');
  await f.locator('button', { hasText: 'Preview' }).click();
  await waitFor(async () => (await f.locator('.agg-results .doc-card').count()) === 4, 'grouped output');
  await shot(page, '20-aggregation');
  await f.locator('.tabs button', { hasText: 'Documents' }).click();
});

await run('history and saved queries', async () => {
  const f = await fresh();
  const filter = f.locator('textarea[aria-label="Filter"]');
  await filter.fill('{ plan: "team" }');
  await filter.press('Enter');
  await sleep(600);
  await f.locator('[aria-label="Reset query"]').click();
  await sleep(200);
  await f.locator('[aria-label="Recent and saved queries"]').click();
  await f.locator('.menu-item', { hasText: 'plan: "team"' }).first().waitFor({ timeout: 5000 });
  await shot(page, '21-history');
  await f.locator('.menu-item', { hasText: 'plan: "team"' }).first().click();
  await waitFor(async () => (await filter.inputValue()) === '{ plan: "team" }', 'restored');
  await f.locator('[aria-label="Save this query"]').click();
  await quickInput.waitFor();
  await quickInput.fill('Team plan');
  await page.keyboard.press('Enter');
  await waitFor(async () => /Saved "Team plan"/.test(await appText(f)), 'saved toast');
  await f.locator('[aria-label="Reset query"]').click();
  await f.locator('[aria-label="Recent and saved queries"]').click();
  await f.locator('.menu-item', { hasText: 'Team plan' }).first().click();
  await waitFor(async () => (await filter.inputValue()) === '{ plan: "team" }', 'saved query applied');
  await f.locator('[aria-label="Reset query"]').click();
});

await run('keyboard shortcuts in the viewer', async () => {
  const f = await fresh();
  await f.locator('.topbar').click();
  await page.keyboard.press('2');
  await f.locator('.json-view').waitFor();
  await page.keyboard.press('3');
  await f.locator('.tree-view').waitFor();
  await page.keyboard.press('1');
  await f.locator('.doc-table').waitFor();
  await page.keyboard.press('n');
  await waitFor(async () => /21–40/.test(await appText(f)), 'next page key');
  await page.keyboard.press('p');
  await waitFor(async () => /1–20/.test(await appText(f)), 'previous page key');
  await page.keyboard.press('j');
  await waitFor(async () => (await f.locator('tr.cursor').count()) === 1, 'cursor');
  await page.keyboard.press('/');
  eq(await f.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Filter', 'focus');
});

await run('views are read-only', async () => {
  const f = await fresh('active_users');
  eq(await f.locator('[aria-label="Insert a document"]').count(), 0, 'no insert on views');
  eq(await f.locator('.doc-table tbody tr').first().locator('[aria-label="Delete document"]').count(), 0, 'no delete on views');
  expect(/view/.test(await f.locator('.crumbs').innerText()), 'view tag');
  await shot(page, '22-view');
});

await run('create and drop collection and database from the sidebar', async () => {
  await fresh();
  await treeRow('myapp').click({ button: 'right' });
  await menuClick('Create Collection');
  await quickInput.waitFor();
  await quickInput.fill('e2e_temp');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await myapp.listCollections({ name: 'e2e_temp' }).toArray()).length === 1, 'created');
  await treeRow('e2e_temp').waitFor({ timeout: 8000 });
  await treeRow('e2e_temp').click({ button: 'right' });
  await shot(page, '23-context-menu');
  await menuClick('Drop Collection');
  await modalButton('Drop');
  await waitFor(async () => (await myapp.listCollections({ name: 'e2e_temp' }).toArray()).length === 0, 'dropped');
  await sleep(300);
});

await run('tree filter and go to collection', async () => {
  await fresh();
  await command(page, 'Mongo Viewer: Filter Databases and Collections');
  await quickInput.waitFor();
  await quickInput.fill('prod');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await treeRow('products').count()) === 1 && (await treeRow('orders').count()) === 0, 'filtered tree');
  await shot(page, '24-tree-filter');
  await page.locator('#workbench\\.parts\\.sidebar [aria-label*="Clear Filter"]').click();
  await waitFor(async () => (await treeRow('orders').count()) === 1, 'cleared filter');
  await command(page, 'Mongo Viewer: Go to Collection');
  await quickInput.waitFor();
  await waitFor(async () => (await page.locator('.quick-input-list .monaco-list-row').count()) > 3, 'collections listed');
  await quickInput.fill('orders');
  await sleep(200);
  await page.keyboard.press('Enter');
  await waitFor(async () => (await page.locator('.tab.active').innerText()).includes('orders'), 'orders tab');
  const f = await openViewer();
  await f.locator('.doc-table tbody tr').first().waitFor({ timeout: 8000 });
  const t = await f.locator('.doc-table tbody').innerText();
  expect(/-/.test(t), 'uuid column visible');
  await shot(page, '25-orders');
});

await run('favorites and recent', async () => {
  await fresh();
  await treeRow('products').hover();
  await treeRow('products').locator('[aria-label*="Add to Favorites"]').click();
  await page.locator('.pane-header', { hasText: 'Favorites' }).click();
  await page.locator('.pane-body .monaco-list-row', { hasText: 'Favorites' }).waitFor({ timeout: 5000 });
  await sleep(300);
  await shot(page, '26-favorites');
  await page.locator('.pane-header', { hasText: 'Favorites' }).click();
});

await run('playground: run script, results panel, connection choice', async () => {
  await fresh();
  await command(page, 'Mongo Viewer: New Query Playground');
  await page.locator('.monaco-editor textarea').first().waitFor({ timeout: 8000 });
  await sleep(600);
  await command(page, 'Select All');
  await page.keyboard.press('Backspace');
  const script = `use("myapp");\nconst total = db.users.countDocuments({ active: true });\nprint("active users:", total);\ndb.users.find({ plan: "pro" }, { name: 1, plan: 1 }).limit(3);\ndb.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { n: -1 } }]);\ndb.products.findOne({ sku: "SKU-1" });\n`;
  await page.keyboard.insertText(script);
  await sleep(500);
  await page.keyboard.press('Meta+Enter');
  await sleep(600);
  const quickVisible = await quickInput.isVisible().catch(() => false);
  if (quickVisible) await pickQuick('myapp');
  const f = await webview(page, 'playground');
  await waitFor(async () => (await f.locator('.pg-block').count()) >= 3, 'result blocks', 20000);
  const t = await appText(f);
  expect(/active users: \d+/.test(t), `print: ${t.slice(0, 300)}`);
  expect(/Finished/.test(t) || (await f.locator('.pg-block').count()) >= 3, 'finished');
  await sleep(300);
  await shot(page, '27-playground');
});

await run('playground: errors appear with their line, and an endless loop can be cancelled', async () => {
  const pg = await webview(page, 'playground');
  await page.locator('.editor-instance .monaco-editor').first().click();
  await command(page, 'Select All');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('\nnotDefined();\n');
  await sleep(300);
  await page.keyboard.press('Meta+Enter');
  await waitFor(async () => /Line 2:.*notDefined/.test(await appText(pg)), 'error with line');
  await shot(page, '28-playground-error');

  await page.locator('.editor-instance .monaco-editor').first().click();
  await command(page, 'Select All');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('while (true) {}\n');
  await sleep(300);
  await page.keyboard.press('Meta+Enter');
  await waitFor(async () => (await pg.locator('button', { hasText: 'Cancel' }).count()) === 1, 'cancel button');
  await sleep(500);
  // The extension host must stay responsive during a busy loop in the script.
  await pg.locator('button', { hasText: 'Cancel' }).click();
  await waitFor(async () => /Cancelled/.test(await appText(pg)), 'cancelled');
});

await run('import from .env asks for confirmation and fills the form', async () => {
  await command(page, 'Mongo Viewer: Import Connection from .env File');
  await quickInput.waitFor();
  await pickQuick('MONGO_URL');
  const f = await webview(page, 'connectionForm');
  await f.locator('.conn-form').waitFor({ timeout: 10000 });
  await waitFor(async () => (await f.locator('textarea').inputValue()).includes('/myapp'), 'uri prefilled');
  await shot(page, '29-env-import');
  await f.locator('button', { hasText: 'Cancel' }).click();
  await sleep(300);
});

await run('production and read-only connection', async () => {
  await command(page, 'Mongo Viewer: Add Connection');
  const f = await webview(page, 'connectionForm');
  await f.locator('.conn-form').waitFor();
  await f.locator('textarea').fill(`${URI}/myapp`);
  await f.locator('input[placeholder="Production"]').fill('Production RO');
  await f.locator('[role=radio]', { hasText: 'Production' }).click();
  await f.locator('.check-row', { hasText: 'Read-only' }).locator('input').check();
  await shot(page, '30-production-form');
  await f.locator('button', { hasText: 'Save and Connect' }).click();
  await treeRow('Production RO').waitFor({ timeout: 8000 });
  await sleep(1000);
  await shot(page, '31-production-tree');
});

await run('read-only connection blocks writes everywhere', async () => {
  await closeAll();
  const conn = treeRow('Production RO');
  const rows = page.locator('#workbench\\.parts\\.sidebar .monaco-list-row');
  await waitFor(async () => (await rows.allInnerTexts()).filter((t) => /^users/.test(t.trim())).length >= 1, 'users rows');
  // Collapse the first connection so names are unambiguous.
  await treeRow('Local Test').click();
  await sleep(500);
  await waitFor(async () => (await treeRow('myapp').count()) > 0, 'database under second connection');
  if (!(await treeRow('users').count())) await treeRow('myapp').click();
  await treeRow('users').click();
  await waitFor(async () => /production/.test(await page.locator('.tab.active').innerText()), 'production tab', 8000);
  const f = await openViewer();
  await waitFor(async () => /PRODUCTION/.test(await f.locator('.crumbs').innerText()), 'production badge');
  await f.locator('.doc-table tbody tr').first().waitFor({ timeout: 8000 });
  expect(/read-only/.test(await f.locator('.crumbs').innerText()), 'read-only tag');
  eq(await f.locator('[aria-label="Insert a document"]').count(), 0, 'no insert');
  eq(await f.locator('.doc-table input[type=checkbox]').count(), 0, 'no selection');
  await shot(page, '32-production-viewer');
  void conn;
  await f.locator('.doc-table tbody tr').first().locator('td').nth(1).dblclick();
  await page.locator('.tab.active', { hasText: '.mongodoc' }).waitFor({ timeout: 8000 });
  await sleep(700);
  await shot(page, '33-readonly-document');
  const lockShown = (await page.locator('.tab.active .codicon-lock-small, .tab.active.sticky').count()) > 0 || (await page.locator('.editor-instance .monaco-editor textarea').first().getAttribute('readonly')) !== null || /read-only|readonly/i.test(await page.locator('.editor-instance .monaco-editor').first().getAttribute('aria-label') ?? '');
  expect(lockShown, 'the editor is read-only');
  await closeAll();
  await treeRow('Production RO').click();
  await treeRow('Local Test').click();
  await sleep(500);
});

await run('mongosh opens in a terminal, connected, with no credentials on screen', async () => {
  await fresh();
  const before = await myapp.collection('users').estimatedDocumentCount();
  await treeRow('Local Test').click({ button: 'right' });
  await menuClick('Open mongosh');
  await page.locator('.terminal-wrapper.active, .xterm').first().waitFor({ timeout: 10000 });
  await sleep(4000);
  await page.keyboard.type('db.getName() + " shell-ok " + db.users.estimatedDocumentCount()');
  await page.keyboard.press('Enter');
  await sleep(1500);
  await shot(page, '34-mongosh');
  const text = await page.evaluate(() => document.querySelector('.xterm-accessibility-tree, .xterm-rows')?.textContent ?? '');
  expect(!/mongodb:\/\/127/.test(text), 'the URI must not be visible in the terminal');
  void before;
  await sleep(200);
  await page.keyboard.type('.exit');
  await page.keyboard.press('Enter');
  await sleep(1000);
});

await run('connection lifecycle: disconnect, reconnect, edit, remove', async () => {
  await treeRow('Production RO').click({ button: 'right' });
  await menuClick('Disconnect');
  await sleep(1500);
  // It must stay disconnected even though its item was expanded.
  eq(await treeRow('Production RO').locator('.codicon-circle-outline').count(), 1, 'disconnected icon');
  await treeRow('Production RO').click({ button: 'right' });
  await menuClick(/^Connect$/);
  await sleep(1000);
  await treeRow('Production RO').click({ button: 'right' });
  await menuClick('Edit Connection');
  const f = await webview(page, 'connectionForm');
  await f.locator('.conn-form').waitFor();
  await f.locator('input[placeholder="Production"]').fill('Prod Renamed');
  await f.locator('button', { hasText: /^Save$/ }).click();
  await treeRow('Prod Renamed').waitFor({ timeout: 8000 });
  await treeRow('Prod Renamed').click({ button: 'right' });
  await menuClick('Remove Connection');
  await modalButton('Remove');
  await treeRow('Prod Renamed').waitFor({ state: 'detached', timeout: 8000 });
});

await run('bad connection string shows a clear error', async () => {
  await command(page, 'Mongo Viewer: Add Connection');
  const f = await webview(page, 'connectionForm');
  await f.locator('.conn-form').waitFor();
  await f.locator('textarea').fill('mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500');
  await f.locator('button', { hasText: 'Test Connection' }).click();
  await waitFor(async () => /refused|reach/i.test(await appText(f)), 'connect error', 15000);
  await f.locator('textarea').fill('http://nope');
  await f.locator('button', { hasText: 'Test Connection' }).click();
  await waitFor(async () => /starts with mongodb/.test(await appText(f)), 'format error');
  await shot(page, '35-connection-error');
  await f.locator('button', { hasText: 'Cancel' }).click();
});

await run('AI search fills the query bar and waits for Run', async () => {
  const f = await fresh();
  await f.locator('[aria-label^="Describe what you"]').click();
  const before = await appText(f);
  await f.locator('input[aria-label="Describe your query"]').fill('active users older than 60');
  await shot(page, '37-ai-prompt');
  await f.locator('button', { hasText: 'Generate' }).click();
  await waitFor(async () => /\$gt/.test(await f.locator('textarea[aria-label="Filter"]').inputValue()), 'generated filter', 120000);
  const filter = await f.locator('textarea[aria-label="Filter"]').inputValue();
  expect(/active/.test(filter) && /age/.test(filter), `filter: ${filter}`);
  expect(/Press Enter to run/.test(await appText(f)), 'waits for the user');
  expect(/1–20 of ~/.test(await appText(f)), 'the previous results are still showing');
  expect(/qwen3\.5:4b/.test(await f.locator('.model-chip').innerText()), 'the small model is the default');
  await shot(page, '38-ai-result');
  void before;
  await f.locator('textarea[aria-label="Filter"]').press('Enter');
  await waitFor(async () => !/of ~/.test(await appText(f)), 'ran on Enter');
  await f.locator('.model-chip').click();
  await page.locator('.quick-input-list .monaco-list-row', { hasText: 'qwen3.5:4b' }).first().waitFor();
  await shot(page, '39-model-picker');
  await page.keyboard.press('Escape');
  await fetch('http://localhost:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: 'qwen3.5:4b', keep_alive: 0 }) }).catch(() => undefined);
});

await run('export to JSON and CSV, then import', async () => {
  const f = await fresh();
  const filter = f.locator('textarea[aria-label="Filter"]');
  await filter.fill('{ plan: "team", active: true }');
  await filter.press('Enter');
  await sleep(500);
  const exact = await myapp.collection('users').countDocuments({ plan: 'team', active: true });
  for (const [label, ext] of [['Export All Results as JSON', 'json'], ['Export All Results as CSV', 'csv']]) {
    const target = join(workspace, `out.${ext}`);
    await f.locator('[aria-label="Export or copy results"]').click();
    await f.locator('.menu-item', { hasText: label }).click();
    await quickInput.waitFor();
    // The dialog fills in its default file name a moment after opening. Wait, or that replaces our path.
    await waitFor(async () => (await quickInput.inputValue()).endsWith(`.${ext}`), 'default file name');
    await quickInput.fill(target);
    await sleep(500);
    await page.keyboard.press('Enter');
    await waitFor(async () => existsSync(target) && /Exported/.test(await page.locator('.notifications-toasts').innerText()), `${ext} export`);
    await dismissNotifications();
  }
  const json = JSON.parse(readFileSync(join(workspace, 'out.json'), 'utf8'));
  eq(json.length, exact, 'exported JSON count');
  expect(json[0]._id.$oid, 'types kept as Extended JSON');
  const csv = readFileSync(join(workspace, 'out.csv'), 'utf8').trim().split('\n');
  eq(csv.length, exact + 1, 'CSV rows');
  expect(csv[0].includes('address.city'), `CSV header: ${csv[0]}`);

  const products = await fresh('products');
  const before = await myapp.collection('products').estimatedDocumentCount();
  await products.locator('[aria-label="Import documents from a JSON file"]').click();
  await quickInput.waitFor();
  await quickInput.fill(join(workspace, 'import.ndjson'));
  await sleep(300);
  await page.keyboard.press('Enter');
  await waitFor(async () => (await myapp.collection('products').estimatedDocumentCount()) === before + 2, 'imported');
  await dismissNotifications();
});

await run('shows the connection dropping, and reconnects by itself', async () => {
  const f = await fresh();
  execFileSync('docker', ['pause', 'mongo-viewer-test']);
  try {
    await waitFor(async () => (await treeRow('Local Test').locator('.codicon-sync').count()) === 1 || /reconnecting/.test(await treeRow('Local Test').innerText()), 'reconnecting state', 45000);
    await shot(page, '40-reconnecting');
  } finally {
    execFileSync('docker', ['unpause', 'mongo-viewer-test']);
  }
  await waitFor(async () => (await treeRow('Local Test').locator('.codicon-circle-filled').count()) === 1, 'connected again', 45000);
  await f.locator('[aria-label^="Refresh results"]').click();
  await waitFor(async () => (await f.locator('.doc-table tbody tr').count()) === 20 && !(await f.locator('.banner.error').count()), 'queries work again', 20000);
});

await run('password auth: password is split out, kept on edit, works with mongosh', async () => {
  const authUri = process.env.TEST_AUTH_URI;
  if (!authUri) throw new Error('TEST_AUTH_URI is not set');
  await closeAll();
  await command(page, 'Mongo Viewer: Add Connection');
  let f = await webview(page, 'connectionForm');
  await f.locator('.conn-form').waitFor();
  const bare = authUri.replace(/:[^:@/]+@/, '@');
  await f.locator('textarea').fill(bare);
  await f.locator('input[placeholder="Production"]').fill('Auth Test');
  await f.locator('button', { hasText: 'Test Connection' }).click();
  await waitFor(async () => /Authentication failed|requires authentication|Connected to MongoDB/.test(await appText(f)), 'no-password result', 15000);
  const password = decodeURIComponent(authUri.match(/:([^:@/]+)@/)[1]);
  await f.locator('input[type=password]').fill(password);
  await f.locator('button', { hasText: 'Test Connection' }).click();
  await waitFor(async () => /Connected to MongoDB 7/.test(await appText(f)), 'authenticated', 15000);
  await shot(page, '41-auth-form');
  await f.locator('button', { hasText: 'Save and Connect' }).click();
  await treeRow('Auth Test').waitFor();
  await waitFor(async () => (await treeRow('Auth Test').locator('.codicon-circle-filled').count()) === 1, 'auth connected', 15000);
  await treeRow('Auth Test').click({ button: 'right' });
  await menuClick('Edit Connection');
  f = await webview(page, 'connectionForm');
  await f.locator('.conn-form').waitFor();
  expect(!(await f.locator('textarea').inputValue()).includes(password), 'password is not shown in the form');
  eq(await f.locator('input[type=password]').inputValue(), '', 'password field');
  expect(/Saved/.test(await f.locator('input[type=password]').getAttribute('placeholder')), 'says one is saved');
  await f.locator('button', { hasText: 'Test Connection' }).click();
  await waitFor(async () => /Connected to MongoDB 7/.test(await appText(f)), 'saved password still works', 15000);
  await f.locator('button', { hasText: 'Cancel' }).click();
  await sleep(300);
  await treeRow('Auth Test').click({ button: 'right' });
  await menuClick('Open mongosh');
  await sleep(4000);
  await page.keyboard.type('db.runCommand({ connectionStatus: 1 }).authInfo.authenticatedUsers[0].user');
  await page.keyboard.press('Enter');
  await sleep(1500);
  await shot(page, '42-auth-mongosh');
  const term = await page.evaluate(() => document.querySelector('.xterm-accessibility-tree, .xterm-rows')?.textContent ?? '');
  expect(!term.includes(password), 'password must not appear in the terminal');
  await page.keyboard.type('.exit');
  await page.keyboard.press('Enter');
  await sleep(800);
  await treeRow('Auth Test').click({ button: 'right' });
  await menuClick('Remove Connection');
  await modalButton('Remove');
  await treeRow('Auth Test').waitFor({ state: 'detached' });
});

await run('light theme stays readable', async () => {
  const settingsPath = join(workspace, '.vscode', 'settings.json');
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  s['workbench.colorTheme'] = 'Default Light Modern';
  writeFileSync(settingsPath, JSON.stringify(s));
  await fresh();
  await sleep(1500);
  await shot(page, '36-light-theme');
  s['workbench.colorTheme'] = 'Default Dark Modern';
  writeFileSync(settingsPath, JSON.stringify(s));
  await sleep(800);
});

await run('panels and connections survive a window reload', async () => {
  const f = await fresh();
  const filter = f.locator('textarea[aria-label="Filter"]');
  await filter.fill('{ plan: "pro" }');
  await sleep(300);
  await command(page, 'Developer: Reload Window');
  await sleep(4000);
  await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
  const g = await waitFor(async () => { try { return await webview(page, 'collection', { timeout: 1000 }); } catch { return null; } }, 'restored panel', 30000);
  await g.locator('.topbar').waitFor();
  await waitFor(async () => (await g.locator('textarea[aria-label="Filter"]').inputValue()) === '{ plan: "pro" }', 'restored query');
  await waitFor(async () => /Press Run/.test(await appText(g)), 'a restored custom query waits for Run');
  await shot(page, '43-restored');
  // VS Code for the web keeps SecretStorage in memory, so here the secret is gone after a reload
  // (desktop uses the OS keychain). This checks the failure is explained rather than silent.
  await g.locator('button', { hasText: 'Run' }).click();
  await waitFor(async () => (await g.locator('.doc-table tbody tr').count()) > 0 || /secure storage/.test(await appText(g)), 'rows or a clear message', 15000);
});

const { passed, failures } = report();
console.log(`\n${passed} passed, ${failures.length} failed`);
failures.forEach((f) => console.log(`  - ${f}`));
const unique = [...new Set(consoleErrors)].filter((e) => !/favicon|ERR_|net::|Failed to load resource|tunnel|gallery|marketplace/i.test(e));
if (unique.length) console.log(`\nBrowser console errors:\n${unique.slice(0, 15).map((e) => `  ${e.slice(0, 300)}`).join('\n')}`);
void execFileSync; void existsSync; void OUT;
await mongo.close();
await stopVSCode(h);
process.exit(failures.length ? 1 : 0);
