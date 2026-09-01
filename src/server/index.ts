import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { assertSupportedNodeVersion } from "./node-version";

assertSupportedNodeVersion();

const { BookmarkDatabase } = await import("./db");

const rootDir = process.cwd();
const dbPath = resolve(process.env.BOOKMARK_DB_PATH ?? join(rootDir, "data", "bookmarks.sqlite"));
const migrationsDir = resolve(rootDir, "migrations");
const clientDir = resolve(rootDir, "dist", "client");
const port = Number(process.env.PORT ?? "8787");

const db = new BookmarkDatabase(dbPath);
db.migrate(migrationsDir);

const storageDir = dirname(dbPath);
const app = createApp({ db, storageDir });

if (existsSync(clientDir)) {
  app.use("/*", serveStatic({ root: clientDir }));
  app.get("*", serveStatic({ path: join(clientDir, "index.html") }));
}

serve({ fetch: app.fetch, port });

console.log(`Bookmark Demo server running at http://127.0.0.1:${port}`);
console.log(`SQLite database: ${dbPath}`);
