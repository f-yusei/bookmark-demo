import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Bookmark } from "../shared/bookmarks";

export type BookmarkRow = {
  id: number;
  url: string;
  title: string;
  tags: string;
  memo: string;
  ogp_image_url?: string | null;
  created_at: string;
  updated_at: string;
};

export type BookmarkInput = {
  url: string;
  title: string;
  tags: string;
  memo: string;
  ogpImageUrl: string;
};

export type BookmarkPage = {
  bookmarks: Bookmark[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

export type SearchFilter = {
  sql: string;
  bindings: string[];
};

const toBookmark = (row: BookmarkRow): Bookmark => ({
  id: row.id,
  url: row.url,
  title: row.title,
  tags: row.tags,
  memo: row.memo,
  ogpImageUrl: row.ogp_image_url ?? "",
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const rowToBookmarkRow = (row: unknown): BookmarkRow => row as BookmarkRow;

export class BookmarkDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  migrate(migrationsDir: string) {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const appliedRows = this.db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>;
    const applied = new Set(appliedRows.map((row) => row.name));
    const migrationFiles = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const name of migrationFiles) {
      if (applied.has(name)) {
        continue;
      }

      const sql = readFileSync(join(migrationsDir, name), "utf8");
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
          .run(name, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  listBookmarks(searchFilter: SearchFilter, requestedPage: number, pageSize: number): BookmarkPage {
    const count = this.db
      .prepare(`SELECT COUNT(*) AS total FROM bookmarks ${searchFilter.sql}`)
      .get(...searchFilter.bindings) as { total: number } | undefined;
    const totalCount = count?.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const rows = this.db
      .prepare(
        `SELECT id, url, title, tags, memo, ogp_image_url, created_at, updated_at FROM bookmarks ${searchFilter.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...searchFilter.bindings, pageSize, offset)
      .map(rowToBookmarkRow);

    return {
      bookmarks: rows.map(toBookmark),
      page,
      pageSize,
      totalCount,
      totalPages
    };
  }

  createBookmark(input: BookmarkInput): Bookmark {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO bookmarks (url, title, tags, memo, ogp_image_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, url, title, tags, memo, ogp_image_url, created_at, updated_at"
      )
      .get(input.url, input.title, input.tags, input.memo, input.ogpImageUrl, now, now);

    if (!row) {
      throw new Error("Failed to create bookmark.");
    }

    return toBookmark(rowToBookmarkRow(row));
  }

  updateBookmark(id: number, input: BookmarkInput): Bookmark | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        "UPDATE bookmarks SET url = ?, title = ?, tags = ?, memo = ?, ogp_image_url = ?, updated_at = ? WHERE id = ? RETURNING id, url, title, tags, memo, ogp_image_url, created_at, updated_at"
      )
      .get(input.url, input.title, input.tags, input.memo, input.ogpImageUrl, now, id);

    return row ? toBookmark(rowToBookmarkRow(row)) : null;
  }

  deleteBookmark(id: number): boolean {
    const result = this.db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}
