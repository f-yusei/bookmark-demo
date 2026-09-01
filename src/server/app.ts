import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { BookmarkDatabase } from "./db";
import type { CreateBookmarkRequest, UpdateBookmarkRequest } from "../shared/bookmarks";
import { fetchPageTitle, normalizeUrl } from "./title";
import { storeOgpImage } from "./storage";

export type AppDependencies = {
  db: BookmarkDatabase;
  storageDir: string;
};

const PAGE_SIZE = 10;

const cleanText = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const cleanTags = (value: unknown) =>
  cleanText(value)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(", ");

const getUrlFromPayload = (payload: unknown) => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as CreateBookmarkRequest | UpdateBookmarkRequest).url !== "string"
  ) {
    return null;
  }

  return (payload as CreateBookmarkRequest | UpdateBookmarkRequest).url;
};

const parseBookmarkId = (value: string) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const escapeLikeTerm = (term: string) => term.replace(/[\\%_]/g, (character) => `\\${character}`);

const parseSearchTerms = (value: string | undefined) =>
  cleanText(value)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

const buildSearchFilter = (terms: string[]) => {
  if (terms.length === 0) {
    return {
      sql: "",
      bindings: [] as string[]
    };
  }

  const sql = terms
    .map(() => "(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR memo LIKE ? ESCAPE '\\')")
    .join(" AND ");
  const bindings = terms.flatMap((term) => {
    const pattern = `%${escapeLikeTerm(term)}%`;
    return [pattern, pattern, pattern, pattern];
  });

  return {
    sql: `WHERE ${sql}`,
    bindings
  };
};

const isUniqueError = (error: unknown) =>
  error instanceof Error && error.message.toLowerCase().includes("unique");

export const createApp = ({ db, storageDir }: AppDependencies) => {
  const app = new Hono();

  app.get("/api/bookmarks", (c) => {
    const pageParam = Number(c.req.query("page") ?? "1");
    const requestedPage = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
    const searchTerms = parseSearchTerms(c.req.query("q"));
    const searchFilter = buildSearchFilter(searchTerms);

    return c.json(db.listBookmarks(searchFilter, requestedPage, PAGE_SIZE));
  });

  app.post("/api/bookmarks", async (c) => {
    let payload: unknown;

    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON." }, 400);
    }

    const payloadUrl = getUrlFromPayload(payload);
    if (payloadUrl === null) {
      return c.json({ error: "URL is required." }, 400);
    }

    let url: string;
    try {
      url = normalizeUrl(payloadUrl);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid URL." }, 400);
    }

    const tags = cleanTags((payload as CreateBookmarkRequest).tags);
    const memo = cleanText((payload as CreateBookmarkRequest).memo);
    const title = (await fetchPageTitle(url)) ?? url;
    const ogpImageUrl = await storeOgpImage(url, storageDir);

    try {
      const bookmark = db.createBookmark({ url, title, tags, memo, ogpImageUrl });
      return c.json({ bookmark }, 201);
    } catch (error) {
      if (isUniqueError(error)) {
        return c.json({ error: "This URL is already bookmarked." }, 409);
      }

      return c.json({ error: "Failed to create bookmark." }, 500);
    }
  });

  app.put("/api/bookmarks/:id", async (c) => {
    const id = parseBookmarkId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Bookmark not found." }, 404);
    }

    let payload: unknown;

    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON." }, 400);
    }

    const payloadUrl = getUrlFromPayload(payload);
    if (payloadUrl === null) {
      return c.json({ error: "URL is required." }, 400);
    }

    let url: string;
    try {
      url = normalizeUrl(payloadUrl);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid URL." }, 400);
    }

    const tags = cleanTags((payload as UpdateBookmarkRequest).tags);
    const memo = cleanText((payload as UpdateBookmarkRequest).memo);
    const title = (await fetchPageTitle(url)) ?? url;
    const ogpImageUrl = await storeOgpImage(url, storageDir);

    try {
      const bookmark = db.updateBookmark(id, { url, title, tags, memo, ogpImageUrl });
      if (!bookmark) {
        return c.json({ error: "Bookmark not found." }, 404);
      }

      return c.json({ bookmark });
    } catch (error) {
      if (isUniqueError(error)) {
        return c.json({ error: "This URL is already bookmarked." }, 409);
      }

      return c.json({ error: "Failed to update bookmark." }, 500);
    }
  });

  app.delete("/api/bookmarks/:id", (c) => {
    const id = parseBookmarkId(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Bookmark not found." }, 404);
    }

    if (!db.deleteBookmark(id)) {
      return c.json({ error: "Bookmark not found." }, 404);
    }

    return c.body(null, 204);
  });

  app.get("/ogp/:name", async (c) => {
    const name = c.req.param("name");

    // Prevent directory traversal
    if (name.includes("..") || name.includes("/") || name.includes("\\")) {
      return c.json({ error: "Invalid image name." }, 400);
    }

    const filepath = join(storageDir, "ogp", name);
    if (!existsSync(filepath)) {
      return c.json({ error: "Image not found." }, 404);
    }

    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      avif: "image/avif"
    };
    const contentType = mimeTypes[extension] || "application/octet-stream";

    try {
      const imageBuffer = readFileSync(filepath);
      c.header("Content-Type", contentType);
      c.header("Cache-Control", "public, max-age=86400, immutable");
      return c.body(imageBuffer);
    } catch {
      return c.json({ error: "Failed to read image." }, 500);
    }
  });

  return app;
};
