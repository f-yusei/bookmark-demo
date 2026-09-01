import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { BookmarkDatabase } from "../src/server/db";

let tempDir: string;
let db: BookmarkDatabase;

const createTestApp = () => createApp({ db, storageDir: tempDir });

const addBookmark = (input: { url: string; title: string; tags?: string; memo?: string }) =>
  db.createBookmark({
    url: input.url,
    title: input.title,
    tags: input.tags ?? "",
    memo: input.memo ?? "",
    ogpImageUrl: ""
  });

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bookmark-demo-"));
  db = new BookmarkDatabase(join(tempDir, "bookmarks.sqlite"));
  db.migrate(join(process.cwd(), "migrations"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("local server bookmarks API", () => {
  it("returns 404 for the removed OGP image endpoint", async () => {
    const response = await createTestApp().request("http://localhost/api/ogp/some-name");

    expect(response.status).toBe(404);
  });

  it("clamps an out-of-range page before selecting bookmarks", async () => {
    for (let index = 1; index <= 21; index += 1) {
      addBookmark({
        url: `https://example.com/${index}`,
        title: `Example ${index}`
      });
    }

    const response = await createTestApp().request("http://localhost/api/bookmarks?page=99");
    const body = await response.json() as {
      bookmarks: Array<{ id: number }>;
      page: number;
      pageSize: number;
      totalCount: number;
      totalPages: number;
    };

    expect(response.status).toBe(200);
    expect(body.page).toBe(3);
    expect(body.pageSize).toBe(10);
    expect(body.totalCount).toBe(21);
    expect(body.totalPages).toBe(3);
    expect(body.bookmarks).toHaveLength(1);
  });

  it("uses AND search terms across bookmark fields", async () => {
    addBookmark({
      url: "https://example.com/hono",
      title: "Hono",
      tags: "typescript, database",
      memo: "Framework"
    });
    addBookmark({
      url: "https://example.com/sqlite",
      title: "SQLite",
      tags: "database",
      memo: "Local data"
    });
    addBookmark({
      url: "https://example.com/react",
      title: "React",
      tags: "ui",
      memo: "Client"
    });

    const response = await createTestApp().request("http://localhost/api/bookmarks?q=hono%20database");
    const body = await response.json() as { bookmarks: Array<{ title: string }>; totalCount: number };

    expect(response.status).toBe(200);
    expect(body.totalCount).toBe(1);
    expect(body.bookmarks.map((bookmark) => bookmark.title)).toEqual(["Hono"]);
  });

  it("creates a bookmark and rejects duplicate normalized URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<title>Example</title>", { headers: { "content-type": "text/html" } }))
    );

    const app = createTestApp();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/#top" })
    };
    const created = await app.request("http://localhost/api/bookmarks", request);
    const duplicate = await app.request("http://localhost/api/bookmarks", request);

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      bookmark: {
        url: "https://example.com/",
        title: "Example"
      }
    });
    expect(duplicate.status).toBe(409);
  });

  it("updates and deletes a bookmark", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<title>Updated</title>", { headers: { "content-type": "text/html" } }))
    );
    const bookmark = addBookmark({
      url: "https://example.com/old",
      title: "Old"
    });
    const app = createTestApp();

    const updated = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/new",
        tags: " local, sqlite ",
        memo: " updated "
      })
    });
    const deleted = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "DELETE"
    });
    const missing = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "DELETE"
    });

    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      bookmark: {
        url: "https://example.com/new",
        title: "Updated",
        tags: "local, sqlite",
        memo: "updated"
      }
    });
    expect(deleted.status).toBe(204);
    expect(missing.status).toBe(404);
  });

  it("downloads and stores OGP image on bookmark creation and serves it via /ogp/:name", async () => {
    const pageHtml = `
      <html>
        <head>
          <title>Page title</title>
          <meta property="og:image" content="https://example.com/some-image.png" />
        </head>
      </html>
    `;
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr === "https://example.com/ogp-page") {
          return new Response(pageHtml, { headers: { "content-type": "text/html" } });
        }
        if (urlStr === "https://example.com/some-image.png") {
          return new Response(imageBytes, { headers: { "content-type": "image/png", "content-length": "8" } });
        }
        return new Response(null, { status: 404 });
      })
    );

    const app = createTestApp();
    const response = await app.request("http://localhost/api/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/ogp-page" })
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { bookmark: { ogpImageUrl: string } };
    expect(body.bookmark.ogpImageUrl).toMatch(/^\/ogp\/[a-f0-9-]+\.png$/);

    // Now request the OGP image
    const ogpName = body.bookmark.ogpImageUrl.replace("/ogp/", "");
    const ogpResponse = await app.request(`http://localhost/ogp/${ogpName}`);
    expect(ogpResponse.status).toBe(200);
    expect(ogpResponse.headers.get("content-type")).toBe("image/png");
    expect(ogpResponse.headers.get("cache-control")).toBe("public, max-age=86400, immutable");

    const returnedBytes = new Uint8Array(await ogpResponse.arrayBuffer());
    expect(returnedBytes).toEqual(imageBytes);

    // Invalid traversal request
    const traversalResponse = await app.request(`http://localhost/ogp/..%2fserver.test.ts`);
    expect(traversalResponse.status).toBe(400);

    // Non-existent image request
    const missingResponse = await app.request(`http://localhost/ogp/missing-image.png`);
    expect(missingResponse.status).toBe(404);
  });

  it("creates a bookmark successfully even if OGP image download fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr === "https://example.com/fail-ogp") {
          return new Response(
            `<html><head><meta property="og:image" content="https://example.com/broken.png" /></head></html>`,
            { headers: { "content-type": "text/html" } }
          );
        }
        if (urlStr === "https://example.com/broken.png") {
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 404 });
      })
    );

    const app = createTestApp();
    const response = await app.request("http://localhost/api/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/fail-ogp" })
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { bookmark: { ogpImageUrl: string } };
    expect(body.bookmark.ogpImageUrl).toBe("");
  });
});
