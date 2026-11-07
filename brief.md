# Mongo Viewer — Feature Specification

## 1. Product vision

Build a lightweight, fast, beautifully integrated VS Code extension for exploring and interacting with MongoDB databases.

Think **MongoDB Atlas Data Explorer + MongoDB Compass, but inside VS Code**, focused on the everyday workflows of a developer.

The extension should feel native to VS Code, with a sidebar for navigation and editor tabs for inspecting, querying, and editing data.

## 2. Database connections

**Essential features**

- Connect using MongoDB connection strings (`mongodb://` and `mongodb+srv://`).
- Support MongoDB Atlas, self-hosted MongoDB, and localhost databases.
- Save multiple connections with custom names (Production, Staging, Local, etc.).
- Connect, disconnect, reconnect, edit, and remove connections.
- Show connection status and errors.
- Automatically reconnect when appropriate.
- Store credentials securely using VS Code SecretStorage.
- Support standard MongoDB authentication and TLS/SSL connections.
- Import a connection string from a `.env` file, with user confirmation.

**Nice to have**

- SSH tunneling.
- Advanced TLS certificate and authentication options.
- Connection-specific colors, especially for production databases.
- Read-only connection mode.

## 3. Database and collection explorer

A collapsible tree in VS Code's left sidebar.

```text
MONGO VIEWER

▾ Production 🟢
    ▾ myapp
        ▸ users                  12.4K
        ▸ orders                 48.2K
        ▸ products                384
        ▸ sessions               92K
    ▸ analytics

▸ Local 🟢
▸ Staging ⚪
```

**Essential features**

- Browse connections → databases → collections.
- Click a collection to open it in an editor tab.
- Refresh a connection, database, or collection.
- Search/filter databases and collections by name.
- Display document counts where available, preferably without expensive blocking queries.
- Right-click context menus for common actions.
- Create and drop databases or collections, with confirmation for destructive operations.
- Support read-only views as well as regular collections.

**Nice to have**

- Favorites / pinned collections.
- Recently opened collections.
- Collection statistics: document count, storage size, average document size.
- Indexes and schema overview.

## 4. Collection viewer — the central feature

Clicking a collection opens a dedicated visual explorer in a VS Code editor tab.

**Three display modes**

**Table view (default)**

| \_id   | name  | email                                          | active |
| ------ | ----- | ---------------------------------------------- | ------ |
| 65a... | Max   | [max@example.com](mailto\:max@example.com)     | true   |
| 65b... | Alice | [alice@example.com](mailto\:alice@example.com) | false  |

**JSON view**

- Pretty-printed documents with syntax highlighting.
- Expand/collapse nested objects and arrays.
- Copy document or individual field values.

**Tree view**

- Hierarchical, expandable representation of documents.
- Useful for deeply nested objects and arrays.

**Essential features**

- Paginated document browsing with configurable page size (20, 50, 100).
- Next/previous page.
- Column sorting and optional column visibility.
- Horizontal scrolling for wide documents.
- Open an individual document for detailed inspection.
- Search by `_id`.
- Copy values, individual documents, or results as JSON.
- Refresh results.
- Show query execution time and number of returned documents.

**Important:** Never load an entire collection into memory. Fetch only what's needed for the current view.

## 5. Query interface

A compact query bar at the top of every collection viewer, inspired by Atlas / Compass.

**Essential features**

- Filter documents using MongoDB query syntax.
- Sort results.
- Select fields using projections.
- Set result limits.
- Press Enter or click Run to execute.
- Display results in Table, JSON, or Tree view.
- Support MongoDB operators such as `$gt`, `$in`, `$or`, `$regex`, etc.
- Syntax highlighting and helpful error messages.
- Fast AI powered search (natural language to mongo query) → Use local API (qwen-3.6-35b-a-3b through ollama, will run on a Macbook Pro 2025 m5 max 40 cores 128GB RAM)

Example:

```javascript
// Filter
{ status: "active", age: { $gte: 18 } }

// Sort
{ createdAt: -1 }

// Projection
{ name: 1, email: 1, _id: 0 }
```

**Nice to have**

- Query history (recently executed queries).
- Save and name favorite queries.
- Field/operator autocomplete.
- Explain query execution plans.
- Generate a query from the current document or selected field.
- Open the current visual query in a Query Playground.

## 6. Document editing (CRUD)

Users should be able to modify documents directly without writing MongoDB commands.

**Essential features**

- Insert a new document.
- Edit an existing document in a JSON editor.
- Add, modify, and remove individual fields.
- Delete a document.
- Save modifications to MongoDB.
- Validate JSON/BSON values before saving.
- Confirm destructive actions.
- Support MongoDB-specific types such as ObjectId, Date, Decimal128, and Binary without silently converting them to ordinary strings.

**UX**

- Double-click a document to open the editor.
- Make changes.
- Click Save or use `Cmd + S`.
- Show clear success/error feedback.
- Prevent accidental overwriting of changes made elsewhere when possible.

**Nice to have**

- Duplicate a document.
- Multi-select and bulk delete/update.
- Diff preview for document changes.
- Undo unsaved changes.

## 7. Integrated mongosh

A fully functional MongoDB Shell directly inside VS Code.

**Essential features**

- Right-click a connection → "Open mongosh".
- Open an integrated VS Code terminal connected to the selected MongoDB instance.
- Execute regular mongosh commands.
- Support all standard shell operations, including queries, updates, aggregation pipelines, and database commands.
- Reuse the selected connection's authentication and configuration.
- Keep the terminal available for interactive use.

Example:

```javascript
use myapp

db.users.find({ active: true }).limit(10)

db.orders.aggregate([
  { $group: { _id: "$status", count: { $sum: 1 } } }
])
```

Use the official `mongosh` executable for full shell compatibility rather than trying to recreate the shell in a custom UI.

## 8. Query Playground

A dedicated editor tab for more complex MongoDB queries and scripts.

**Essential features**

- Write and execute MongoDB queries in JavaScript.
- Support `find`, `findOne`, `aggregate`, `countDocuments`, `insertOne`, `updateOne`, and other operations.
- Run the entire script or a selected query.
- View formatted results in an adjacent panel.
- Syntax highlighting.
- Save scripts in the VS Code workspace.
- Choose which connection/database a script runs against.

**Nice to have**

- MongoDB-aware autocomplete for collection names, fields, and operators.
- Query snippets/templates.
- Execution history.
- Convert a query from the visual collection viewer into a script.

## 9. Schema and index inspection

A dedicated panel for understanding a collection's structure.

**Schema viewer**

- Detect common fields by sampling documents.
- Show field names and detected BSON types.
- Identify frequently missing or nullable fields.
- Explore nested objects and arrays.

**Index viewer**

- List collection indexes.
- Display indexed fields, index types, and options.
- Show unique, sparse, and TTL index properties.
- Create or drop indexes with confirmation.

**Advanced**

- Query explain plans.
- Identify collection scans.
- Surface potentially useful index information.

## 10. Import and export

**Essential features**

- Export selected documents or query results as JSON.
- Export results as CSV.
- Import JSON documents into a collection.
- Copy query results to clipboard.

**Nice to have**

- Bulk imports.
- Progress indicators for large operations.
- Export entire collections.
- Duplicate collections between compatible databases.

## 11. UX, performance, and safety

**Design principles**

- Native-looking VS Code interface.
- Minimal visual clutter.
- Fast connection switching.
- Sidebar for navigation, editor tabs for working with data.
- Keyboard-friendly interactions.
- No need to open a browser or external database tool.

**Performance**

- Lazy-load databases, collections, and documents.
- Use pagination and sensible result limits.
- Keep connections reusable.
- Cancel long-running queries.
- Avoid expensive collection counts or schema scans by default.
- Keep the VS Code interface responsive.

**Safety**

- Never store credentials in plain text.
- Clearly identify production connections.
- Confirm destructive operations.
- Support read-only connections.
- Apply sensible query timeouts.
- Do not execute arbitrary queries automatically.
- Do not expose credentials in logs or terminal command history.

## 12. Technical architecture

**Main technologies**

- TypeScript.
- VS Code Extension API.
- Official MongoDB Node.js driver for database operations.
- VS Code TreeView for connection/database/collection navigation.
- VS Code Webviews for the visual collection explorer, table, and document editor.
- VS Code integrated terminal + official mongosh executable.
- VS Code SecretStorage for credentials.
- Monaco / VS Code native editing features where suitable.

**High-level logic**

```text
VS Code
    │
    ├── Sidebar: Database Explorer
    │       └── Select connection/database/collection
    │
    ├── Editor: Collection Viewer
    │       ├── Table / JSON / Tree
    │       ├── Filter / Sort / Projection
    │       └── Document editing
    │
    ├── Editor: Query Playground
    │       └── Execute MongoDB scripts
    │
    └── Terminal: mongosh
            └── Interactive MongoDB shell

                 ↓

         Extension Backend
         (TypeScript / Node.js)
                 │
         MongoDB Node.js Driver
                 │
              MongoDB
```

The extension backend manages connections, validates requests, executes database operations, and sends paginated results to the Webview.

The Webview only handles user interaction and displaying data. Database credentials and direct connection logic remain in the extension backend.

No external backend, database, or cloud service is required.

## 13. Suggested development priorities

**MVP — Must have**

- MongoDB connections and secure credential storage.
- Database and collection sidebar.
- Collection browsing with Table and JSON views.
- Pagination, filtering, sorting, and projections.
- Document creation, editing, and deletion.
- Integrated mongosh.
- Basic Query Playground.

**V1 — Strong everyday tool**

- Tree view.
- Query history and saved queries.
- Collection search and favorites.
- Import/export.
- Schema and index inspection.
- Better keyboard shortcuts and connection management.

**V2 — Advanced developer features**

- Aggregation pipeline builder.
- Query explain plans and performance inspection.
- Advanced index management.
- Bulk operations.
- Cross-database copy/transfer.
- Optional AI-assisted query generation.

## 14. Definition of success

Mongo Viewer should replace the need to open MongoDB Atlas or Compass for most everyday development tasks.

A developer should be able to **connect, inspect, search, query, edit, and debug MongoDB data in seconds without leaving VS Code**.

The priority is not to recreate the entire MongoDB administration ecosystem. It is to build the fastest and most convenient MongoDB explorer for developers.

Mongo-viewer should feel light, fast, efficient, and VSCode native.
