# Mongo Viewer

Connect, inspect, search, query, edit and debug MongoDB data without leaving VS Code. It covers everyday development work that would otherwise need Atlas Data Explorer or Compass.

## Getting started

1. Open **Mongo Viewer** in the Activity Bar.
2. Click **Add Connection** and paste a `mongodb://` or `mongodb+srv://` string, or use **Import from .env**.
3. Expand the connection and click a collection.

## Features

### Connections

- Atlas, self-hosted and localhost. Auth and TLS options go in the connection string.
- Connection strings are kept in VS Code SecretStorage. Passwords are never shown again in the form and are removed from logs.
- Status in the sidebar, with automatic reconnection when a server comes back.
- Mark a connection as production: it gets red labels, and every write asks for confirmation.
- Read-only mode blocks writes from the viewer, document editor and playgrounds.
- Optional SSH tunnel using your own `ssh` command, config and agent.

### Sidebar

- Connections, databases and collections, loaded when you expand them.
- Document counts from collection metadata, loaded in the background so they never block.
- Filter by name, or jump anywhere with **Go to Collection** (`Cmd+Alt+M` / `Ctrl+Alt+M`).
- Favorites and recent collections.
- Create, drop, rename and copy collections, including to another connection.

### Collection viewer

- Table, JSON and Tree views, with pagination (20, 50 or 100 per page).
- Sort from column headers (Shift-click to add a second field), resize columns, and show or hide them.
- Execution time and result counts. Nothing loads a whole collection into memory.
- Right-click any value to copy it, filter by it, edit it, or add or remove a field.
- Multi-select for bulk update and delete.
- Tabs for **Aggregation** (stage-by-stage builder), **Schema**, **Indexes** and **Stats**.

| Key | Action |
| --- | --- |
| `/` | Focus the filter |
| `Enter` (in a query field) | Run the query |
| `1` `2` `3` | Table, JSON, Tree |
| `n` / `p` | Next or previous page |
| `r` | Refresh |
| `↑` `↓` or `j` `k` | Move between documents |
| `Enter` | Open the current document |
| `Space` | Select the current document |
| `Delete` | Delete the current document (asks first) |

### Query bar

Filter, sort, project and limit in MongoDB syntax, with highlighting, field and operator autocomplete, and clear errors as you type. It accepts all the usual operators and helpers such as `ObjectId()`, `ISODate()` and `Decimal128()`. Input is parsed, never evaluated. Paste a 24-character id into the filter to search by `_id`.

Also included: query history, saved queries, explain plans with index suggestions, and **Open in Playground**.

### Natural-language search

Click the sparkle icon and describe what you want. A local [Ollama](https://ollama.com) model writes the query and fills in the query bar. It only runs when you press Enter, unless you turn on `mongoViewer.ai.autoRun`.

**Changing the model:** click the model name next to the prompt, run **Mongo Viewer: Choose AI Model**, or set `mongoViewer.ai.model`.

| Setting | Default | Notes |
| --- | --- | --- |
| `mongoViewer.ai.model` | `qwen3.5:4b` | Any Ollama model. Punctuation is ignored when matching, so `qwen-3.6-35b-a-3b` finds `qwen3.6:35b-a3b`. If the model isn't installed, the smallest installed Qwen text model is used and you're told. |
| `mongoViewer.ai.endpoint` | `http://localhost:11434` | Field names and short example values are sent here. Example values are only sent to a local endpoint. |

To switch to the larger model on a machine with enough memory:

```bash
ollama pull qwen3.6:35b-a3b
```

Then choose it in the model picker. That tag is the expected name: check the [Ollama library](https://ollama.com/library) if the pull fails.

### Editing documents

Double-click a document to open it in a normal VS Code editor. `Cmd+S` saves to MongoDB, and undo, search and multi-cursor all work as usual.

- **Types are preserved exactly.** Documents appear in shell syntax, so `5` stays an Int32, `5.0` a Double, and `NumberLong("5")`, `Decimal128("1.50")`, dates, binary and UUIDs round-trip byte for byte. Extended JSON is accepted too.
- **Validation** runs as you type and again before saving.
- **Conflict protection:** if a document changed in the database after you opened it, you can compare, overwrite or cancel.
- **Auto-save is off for these editors** even if it's on elsewhere, so a write is always deliberate.
- Compare with the database, duplicate and delete from the editor title bar.

### mongosh

Right-click a connection, database or collection and choose **Open mongosh**. This runs the official shell in an integrated terminal. The connection string reaches it through the process environment and is deleted at startup, so it isn't in the command line, shell history or terminal text. [Install mongosh](https://www.mongodb.com/docs/mongodb-shell/install/) separately. Read-only mode doesn't apply in the terminal, because it's a full shell.

### Query Playground

Write MongoDB scripts in `.mongo.js` files. Run everything with `Cmd+Enter`, select some code to run just that, or use the **Run** link above any statement. Results appear beside the editor, and the status bar shows and changes the target connection and database.

```javascript
use("myapp");

const active = db.users.countDocuments({ active: true });
print("active users:", active);

db.orders.aggregate([
  { $group: { _id: "$status", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
]);
```

`await` is optional, as in mongosh. Autocomplete knows your collections, fields and operators, and there are snippets for common queries. Each run has its own worker thread, so even `while (true) {}` can be cancelled without affecting VS Code.

Read-only mode blocks writes made through the playground API. It's a safeguard against mistakes rather than a security boundary. Use a database user with read-only permissions when you need a guarantee.

### Import and export

Export the current page, selected documents or all results as JSON or CSV, streamed to disk with progress and cancel. Import JSON arrays or newline-delimited JSON, including `mongoexport` output.

## Settings

Search for `mongoViewer` in Settings. The ones you're most likely to change:

| Setting | Default | |
| --- | --- | --- |
| `queryTimeoutMs` | `30000` | Server-side time limit for viewer queries |
| `countTimeoutMs` | `3000` | Filtered counts longer than this are skipped |
| `schemaSampleSize` | `500` | Documents sampled for the schema view |
| `confirmProductionWrites` | `true` | Confirm every write on production connections |
| `mongoshPath` | | Path to `mongosh` if it isn't on your `PATH` |
| `playground.resultLimit` | `100` | Documents shown per cursor result |

## Development

```bash
npm install
npm run build
```

Press `F5` to run the extension in a development window, or build a package to install:

```bash
npm run package
```

### Tests

Tests need a disposable MongoDB. **The E2E suite drops the `myapp` and `analytics` databases on the server it's given**, so never point it at real data.

```bash
docker run -d --rm --name mongo-viewer-test -p 127.0.0.1:27099:27017 mongo:7
```

```bash
npm test
```

The E2E suite drives the real VS Code UI in headless Chromium, so no windows open:

```bash
MV_E2E_DATA=/tmp/mv-e2e npm run e2e
```

- `test/unit`: parser, type round-trips, and operations against a real server.
- `test/unit/ai-eval.test.ts`: real model output against real data. Run it with `MV_AI_EVAL=1`.
- `test/e2e`: full user flows. Set `TEST_AUTH_URI` to a second disposable server for the password-auth flow, `MV_CHROME` to reuse an installed Chromium, and `MV_E2E_EXTENSION` to test an unpacked VSIX.

## Architecture

```text
src/shared      Used by both sides: query parser, wire format, protocol. No dependencies.
src/core        Database logic with no VS Code imports, so it's tested directly.
src/playground  Script transform and runtime, run in a worker thread.
src/host        VS Code integration: tree, panels, document file system, terminal.
src/webview     Preact UI. It only displays data and sends requests.
```

Webviews never see credentials and never talk to MongoDB. Documents cross to them in a typed format that keeps every BSON type intact. No external service is involved.
