import { describe, expect, it, vi } from "vitest";
import { extractTitle, fetchPageTitle, normalizeUrl } from "../src/server/title";

describe("normalizeUrl", () => {
  it("normalizes http and https URLs and removes fragments", () => {
    expect(normalizeUrl(" https://example.com/path#section ")).toBe("https://example.com/path");
  });

  it("rejects unsupported protocols", () => {
    expect(() => normalizeUrl("ftp://example.com/file")).toThrow("Only http and https URLs");
  });
});

describe("extractTitle", () => {
  it("extracts and decodes the page title", () => {
    expect(extractTitle("<html><title>Example &amp; Demo</title></html>")).toBe("Example & Demo");
  });

  it("returns null when no title exists", () => {
    expect(extractTitle("<html><body>No title</body></html>")).toBeNull();
  });
});

describe("fetchPageTitle", () => {
  it("returns title for html responses", async () => {
    const fetcher = vi.fn(async () => new Response("<title>Saved page</title>", {
      headers: { "content-type": "text/html; charset=utf-8" }
    }));

    await expect(fetchPageTitle("https://example.com", fetcher as typeof fetch)).resolves.toBe("Saved page");
  });

  it("returns null when fetch fails", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network failed");
    });

    await expect(fetchPageTitle("https://example.com", fetcher as typeof fetch)).resolves.toBeNull();
  });

  it("aborts slow title requests", async () => {
    vi.useFakeTimers();

    const fetcher = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );

    const result = fetchPageTitle("https://example.com", fetcher as typeof fetch);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(result).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );

    vi.useRealTimers();
  });

  it("rejects private URL targets before fetching", async () => {
    const fetcher = vi.fn(async () => new Response("<title>Private</title>"));

    await expect(fetchPageTitle("http://127.0.0.1", fetcher as typeof fetch)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects reserved IPv4 and IPv6 URL targets before fetching", async () => {
    const fetcher = vi.fn(async () => new Response("<title>Reserved</title>"));

    await expect(fetchPageTitle("http://192.0.2.1", fetcher as typeof fetch)).resolves.toBeNull();
    await expect(fetchPageTitle("http://[2001:db8::1]", fetcher as typeof fetch)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not follow redirects to private URL targets", async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" }
    }));

    await expect(fetchPageTitle("https://example.com", fetcher as typeof fetch)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
