import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { BookmarkDatabase } from "../src/server/db";

let tempDir: string;
let db: BookmarkDatabase;

const createTestApp = () => createApp({ db, storageDir: tempDir });

const addBookmark = (input: { url: string; title: string; tags?: string; memo?: string; ogpImageUrl?: string }) =>
  db.createBookmark({
    url: input.url,
    title: input.title,
    tags: input.tags ?? "",
    memo: input.memo ?? "",
    ogpImageUrl: input.ogpImageUrl ?? ""
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

    const responses = new Map([
      ["https://example.com/ogp-page", new Response(pageHtml, { headers: { "content-type": "text/html" } })],
      [
        "https://example.com/some-image.png",
        new Response(imageBytes, { headers: { "content-type": "image/png", "content-length": "8" } })
      ]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) =>
      responses.get(url.toString())?.clone() ?? new Response(null, { status: 404 })
    ));

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

  it("keeps OGP files synchronized when updating and deleting a bookmark", async () => {
    const oldImageUrl = "/ogp/00000000-0000-4000-8000-000000000000.png";
    const oldImagePath = join(tempDir, oldImageUrl);
    mkdirSync(join(tempDir, "ogp"), { recursive: true });
    writeFileSync(oldImagePath, new Uint8Array([1]));
    const bookmark = addBookmark({
      url: "https://example.com/old-image",
      title: "Old image",
      ogpImageUrl: oldImageUrl
    });
    const pageHtml = `<title>New image</title><meta property="og:image" content="https://example.com/new.png">`;
    const responses = new Map([
      ["https://example.com/new-image", new Response(pageHtml, { headers: { "content-type": "text/html" } })],
      [
        "https://example.com/new.png",
        new Response(new Uint8Array([2]), { headers: { "content-type": "image/png", "content-length": "1" } })
      ]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) =>
      responses.get(url.toString())?.clone() ?? new Response(null, { status: 404 })
    ));
    const app = createTestApp();

    const updated = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/new-image" })
    });
    const body = await updated.json() as { bookmark: { ogpImageUrl: string } };

    expect(updated.status).toBe(200);
    expect(existsSync(oldImagePath)).toBe(false);
    expect(existsSync(join(tempDir, body.bookmark.ogpImageUrl))).toBe(true);

    const deleted = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(existsSync(join(tempDir, body.bookmark.ogpImageUrl))).toBe(false);
  });

  it("removes a newly stored OGP file when bookmark creation or update fails", async () => {
    const existingImageUrl = "/ogp/00000000-0000-4000-8000-000000000000.png";
    mkdirSync(join(tempDir, "ogp"), { recursive: true });
    writeFileSync(join(tempDir, existingImageUrl), new Uint8Array([1]));
    const bookmark = addBookmark({
      url: "https://example.com/original",
      title: "Original",
      ogpImageUrl: existingImageUrl
    });
    addBookmark({ url: "https://example.com/duplicate", title: "Duplicate" });
    const pageHtml = `<title>Duplicate</title><meta property="og:image" content="https://example.com/new.png">`;
    const responses = new Map([
      ["https://example.com/duplicate", new Response(pageHtml, { headers: { "content-type": "text/html" } })],
      [
        "https://example.com/new.png",
        new Response(new Uint8Array([2]), { headers: { "content-type": "image/png", "content-length": "1" } })
      ]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) =>
      responses.get(url.toString())?.clone() ?? new Response(null, { status: 404 })
    ));
    const app = createTestApp();
    const request = {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/duplicate" })
    };

    const createResponse = await app.request("http://localhost/api/bookmarks", { method: "POST", ...request });
    const updateResponse = await app.request(`http://localhost/api/bookmarks/${bookmark.id}`, {
      method: "PUT",
      ...request
    });

    expect(createResponse.status).toBe(409);
    expect(updateResponse.status).toBe(409);
    expect(readdirSync(join(tempDir, "ogp"))).toEqual([existingImageUrl.replace("/ogp/", "")]);
  });

  it("creates a bookmark successfully even if OGP image download fails", async () => {
    const responses = new Map([
      [
        "https://example.com/fail-ogp",
        new Response(
          `<html><head><meta property="og:image" content="https://example.com/broken.png" /></head></html>`,
          { headers: { "content-type": "text/html" } }
        )
      ],
      ["https://example.com/broken.png", new Response(null, { status: 500 })]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) =>
      responses.get(url.toString())?.clone() ?? new Response(null, { status: 404 })
    ));

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
