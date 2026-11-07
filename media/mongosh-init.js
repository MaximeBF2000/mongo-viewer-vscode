// Loaded by mongosh when Mongo Viewer opens a terminal. The connection string arrives
// through the environment, and is removed before the prompt appears.
(function () {
  const uri = process.env.MONGO_VIEWER_URI;
  const name = process.env.MONGO_VIEWER_DB;
  delete process.env.MONGO_VIEWER_URI;
  delete process.env.MONGO_VIEWER_DB;
  if (!uri) {
    print('Mongo Viewer: no connection information was provided.');
    return;
  }
  globalThis.db = connect(uri);
  if (name) globalThis.db = globalThis.db.getSiblingDB(name);
})();
