import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { extractOgImageUrl } from "../src/server/ogp";
import { storeOgpImage } from "../src/server/storage";

describe("extractOgImageUrl", () => {
  const baseUrl = "https://example.com/blog/post-1";

  it("extracts absolute og:image URL from property attribute", () => {
    const html = `<html><head><meta property="og:image" content="https://images.example.com/pic.png" /></head></html>`;
    expect(extractOgImageUrl(html, baseUrl)).toBe("https://images.example.com/pic.png");
  });

  it("extracts absolute og:image:url URL from property attribute", () => {
    const html = `<html><head><meta property="og:image:url" content="https://images.example.com/pic.png" /></head></html>`;
    expect(extractOgImageUrl(html, baseUrl)).toBe("https://images.example.com/pic.png");
  });

  it("extracts og:image URL from name attribute", () => {
    const html = `<html><head><meta name="og:image" content="https://images.example.com/pic.png" /></head></html>`;
    expect(extractOgImageUrl(html, baseUrl)).toBe("https://images.example.com/pic.png");
  });

  it("resolves relative og:image URL against baseUrl", () => {
    const html = `<html><head><meta property="og:image" content="/images/pic.png" /></head></html>`;
    expect(extractOgImageUrl(html, baseUrl)).toBe("https://example.com/images/pic.png");
  });

  it("ignores non-http/https protocols", () => {
    const html = `<html><head><meta property="og:image" content="ftp://example.com/pic.png" /></head></html>`;
    expect(extractOgImageUrl(html, baseUrl)).toBeNull();
  });

  it("ignores meta tags inside HTML comments", () => {
    const html = `
      <html>
        <head>
          <!-- <meta property="og:image" content="https://ignored.com/pic.png" /> -->
          <meta property="og:image" content="https://real.com/pic.png" />
        </head>
      </html>
    `;
    expect(extractOgImageUrl(html, baseUrl)).toBe("https://real.com/pic.png");
  });

  it("decodes HTML entities in content attribute", () => {
    const html = `<html><head><meta property="og:image" content="https://example.com/pic.png?w=200&amp;h=300" /></head></html>`;
    expect(extractOgImageUrl(html, baseUrl)).toBe("https://example.com/pic.png?w=200&h=300");
  });

  it("returns null if no og:image is found", () => {
    const html = `<html><head><title>No image here</title></head></html>`;
    expect(extractOgImageUrl(html, baseUrl)).toBeNull();
  });
});

describe("storeOgpImage", () => {
  const tempStorageDir = join(process.cwd(), "test_temp_storage");

  beforeEach(() => {
    mkdirSync(tempStorageDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempStorageDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("fetches page and image, saves it and returns path", async () => {
    const htmlResponse = new Response("<html><head><meta property='og:image' content='https://example.com/img.png' /></head></html>", {
      headers: { "content-type": "text/html; charset=utf-8" }
    });

    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const imageResponse = new Response(imageBytes, {
      headers: { "content-type": "image/png", "content-length": "4" }
    });

    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr === "https://example.com/page") {
        return htmlResponse;
      }
      if (urlStr === "https://example.com/img.png") {
        return imageResponse;
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const result = await storeOgpImage("https://example.com/page", tempStorageDir, fetcher as typeof fetch);
    
    expect(result).toMatch(/^\/ogp\/[a-f0-9-]+\.png$/);
    const savedFilename = result.substring(5); // remove '/ogp/'
    const localPath = join(tempStorageDir, "ogp", savedFilename);
    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath)).toEqual(Buffer.from(imageBytes));
  });

  it("returns empty string if content-type is not text/html", async () => {
    const jsonResponse = new Response('{"key": "val"}', {
      headers: { "content-type": "application/json" }
    });

    const fetcher = vi.fn(async () => jsonResponse);

    const result = await storeOgpImage("https://example.com/page", tempStorageDir, fetcher as typeof fetch);
    expect(result).toBe("");
  });

  it("returns empty string if og:image is not found", async () => {
    const htmlResponse = new Response("<html><head><title>No image</title></head></html>", {
      headers: { "content-type": "text/html" }
    });

    const fetcher = vi.fn(async () => htmlResponse);

    const result = await storeOgpImage("https://example.com/page", tempStorageDir, fetcher as typeof fetch);
    expect(result).toBe("");
  });

  it("returns empty string if image content-type is unsupported", async () => {
    const htmlResponse = new Response("<html><head><meta property='og:image' content='https://example.com/img.svg' /></head></html>", {
      headers: { "content-type": "text/html" }
    });

    // SVG is not in the allowed list of PNG, JPEG, WebP, GIF, AVIF
    const imageResponse = new Response("<svg></svg>", {
      headers: { "content-type": "image/svg+xml" }
    });

    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr === "https://example.com/page") return htmlResponse;
      if (urlStr === "https://example.com/img.svg") return imageResponse;
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const result = await storeOgpImage("https://example.com/page", tempStorageDir, fetcher as typeof fetch);
    expect(result).toBe("");
  });

  it("returns empty string if image size is > 5MB", async () => {
    const htmlResponse = new Response("<html><head><meta property='og:image' content='https://example.com/large.png' /></head></html>", {
      headers: { "content-type": "text/html" }
    });

    const largeResponse = new Response(null, {
      headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) }
    });

    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr === "https://example.com/page") return htmlResponse;
      if (urlStr === "https://example.com/large.png") return largeResponse;
      throw new Error(`Unexpected url: ${urlStr}`);
    });

    const result = await storeOgpImage("https://example.com/page", tempStorageDir, fetcher as typeof fetch);
    expect(result).toBe("");
  });
});
