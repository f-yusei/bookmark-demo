import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import type { Bookmark } from "../src/shared/bookmarks";

const mockFetch = vi.fn<typeof fetch>();

const makeBookmark = (overrides: Partial<Bookmark> = {}): Bookmark => ({
  id: 1,
  url: "https://example.com/",
  title: "Example",
  tags: "docs, demo",
  memo: "Useful reference",
  ogpImageUrl: "",
  createdAt: "2026-05-16T00:00:00.000Z",
  updatedAt: "2026-05-16T00:00:00.000Z",
  ...overrides
});

const bookmarksResponse = (
  bookmarks: Bookmark[],
  pagination: Partial<{ page: number; pageSize: number; totalCount: number; totalPages: number }> = {}
) =>
  Response.json({
    bookmarks,
    page: pagination.page ?? 1,
    pageSize: pagination.pageSize ?? 10,
    totalCount: pagination.totalCount ?? bookmarks.length,
    totalPages: pagination.totalPages ?? 1
  });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

describe("App", () => {
  it("loads and renders bookmarks with tags and memo", async () => {
    mockFetch.mockResolvedValueOnce(bookmarksResponse([makeBookmark()]));

    render(<App />);

    expect(await screen.findByRole("link", { name: "Example" })).toHaveAttribute(
      "href",
      "https://example.com/"
    );
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.getByText("demo")).toBeInTheDocument();
    expect(screen.getByText("Useful reference")).toBeInTheDocument();
  });

  it("adds a bookmark from the URL-only form and refreshes the first page", async () => {
    mockFetch
      .mockResolvedValueOnce(bookmarksResponse([]))
      .mockResolvedValueOnce(Response.json({ bookmark: makeBookmark({ id: 2 }) }, { status: 201 }))
      .mockResolvedValueOnce(bookmarksResponse([makeBookmark({ id: 2 })]));

    render(<App />);

    await screen.findByText("No bookmarks yet.");
    await userEvent.type(screen.getByLabelText("URL"), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/bookmarks", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          url: "https://example.com"
        })
      });
    });

    expect(await screen.findByRole("link", { name: "Example" })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1");
  });

  it("edits a bookmark and refreshes the current page", async () => {
    mockFetch
      .mockResolvedValueOnce(bookmarksResponse([makeBookmark()]))
      .mockResolvedValueOnce(Response.json({ bookmark: makeBookmark({ tags: "updated" }) }))
      .mockResolvedValueOnce(bookmarksResponse([makeBookmark({ tags: "updated" })]));

    render(<App />);

    await screen.findByRole("link", { name: "Example" });
    await userEvent.click(screen.getByRole("button", { name: "Edit Example" }));
    const editTagsInput = screen.getByLabelText("Tags");
    await userEvent.clear(editTagsInput);
    await userEvent.type(editTagsInput, "updated");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/bookmarks/1", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          url: "https://example.com/",
          tags: "updated",
          memo: "Useful reference"
        })
      });
    });

    expect(await screen.findByText("updated")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1");
  });

  it("confirms deletion before deleting and refreshing the list", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    mockFetch
      .mockResolvedValueOnce(bookmarksResponse([makeBookmark()]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(bookmarksResponse([]));

    render(<App />);

    await screen.findByRole("link", { name: "Example" });
    await userEvent.click(screen.getByRole("button", { name: "Delete Example" }));

    expect(window.confirm).toHaveBeenCalledWith('Delete "Example"?');
    await waitFor(() => {
      expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/bookmarks/1", {
        method: "DELETE"
      });
    });
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1");
  });

  it("loads the next page", async () => {
    mockFetch
      .mockResolvedValueOnce(
        bookmarksResponse([makeBookmark()], { page: 1, totalCount: 11, totalPages: 2 })
      )
      .mockResolvedValueOnce(
        bookmarksResponse([makeBookmark({ id: 2, title: "Next page" })], {
          page: 2,
          totalCount: 11,
          totalPages: 2
        })
      );

    render(<App />);

    await screen.findByRole("link", { name: "Example" });
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("link", { name: "Next page" })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=2");
  });

  it("searches bookmarks and keeps the query in pagination", async () => {
    mockFetch
      .mockResolvedValueOnce(bookmarksResponse([]))
      .mockResolvedValueOnce(
        bookmarksResponse([makeBookmark({ title: "Search result" })], {
          page: 1,
          totalCount: 11,
          totalPages: 2
        })
      )
      .mockResolvedValueOnce(
        bookmarksResponse([makeBookmark({ id: 2, title: "More results" })], {
          page: 2,
          totalCount: 11,
          totalPages: 2
        })
      );

    render(<App />);

    await screen.findByText("No bookmarks yet.");
    await userEvent.type(screen.getByLabelText("Search bookmarks"), "bookmark social");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByRole("link", { name: "Search result" })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1&q=bookmark+social");
    expect(window.location.search).toBe("?q=bookmark+social");

    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("link", { name: "More results" })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=2&q=bookmark+social");
    expect(window.location.search).toBe("?page=2&q=bookmark+social");
  });

  it("keeps the URL in sync after creating while search is active", async () => {
    mockFetch
      .mockResolvedValueOnce(bookmarksResponse([]))
      .mockResolvedValueOnce(
        bookmarksResponse([makeBookmark({ title: "Search result" })], {
          page: 1,
          totalCount: 1,
          totalPages: 1
        })
      )
      .mockResolvedValueOnce(Response.json({ bookmark: makeBookmark({ id: 2 }) }, { status: 201 }))
      .mockResolvedValueOnce(bookmarksResponse([makeBookmark({ id: 2 })]));

    render(<App />);

    await screen.findByText("No bookmarks yet.");
    await userEvent.type(screen.getByLabelText("Search bookmarks"), "docs");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("link", { name: "Search result" });
    await userEvent.type(screen.getByLabelText("URL"), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1&q=docs");
    });
    expect(window.location.search).toBe("?q=docs");
  });

  it("keeps the URL in sync after deleting the last bookmark on a page", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    window.history.replaceState(null, "", "/?page=2&q=docs");
    mockFetch
      .mockResolvedValueOnce(
        bookmarksResponse([makeBookmark()], { page: 2, totalCount: 11, totalPages: 2 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        bookmarksResponse([makeBookmark({ id: 2 })], { page: 1, totalCount: 10, totalPages: 1 })
      );

    render(<App />);

    await screen.findByRole("link", { name: "Example" });
    await userEvent.click(screen.getByRole("button", { name: "Delete Example" }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1&q=docs");
    });
    expect(window.location.search).toBe("?q=docs");
  });

  it("loads the initial search state from the URL", async () => {
    window.history.replaceState(null, "", "/?page=2&q=docs");
    mockFetch.mockResolvedValueOnce(
      bookmarksResponse([makeBookmark({ title: "URL state result" })], {
        page: 2,
        totalCount: 11,
        totalPages: 2
      })
    );

    render(<App />);

    expect(await screen.findByRole("link", { name: "URL state result" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search bookmarks")).toHaveValue("docs");
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=2&q=docs");
  });

  it("shows error and preserves query on failed search", async () => {
    window.history.replaceState(null, "", "/?q=fail");
    mockFetch.mockResolvedValueOnce(Response.json({ error: "Search failed." }, { status: 500 }));

    render(<App />);

    expect(await screen.findByText("Search failed.")).toBeInTheDocument();
    expect(screen.getByLabelText("Search bookmarks")).toHaveValue("fail");
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1&q=fail");
    expect(window.location.search).toBe("?q=fail");
  });

  it("reloads bookmarks when browser history changes", async () => {
    mockFetch
      .mockResolvedValueOnce(bookmarksResponse([]))
      .mockResolvedValueOnce(bookmarksResponse([makeBookmark({ title: "History result" })]));

    render(<App />);

    await screen.findByText("No bookmarks yet.");
    act(() => {
      window.history.pushState(null, "", "/?q=history");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(await screen.findByRole("link", { name: "History result" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search bookmarks")).toHaveValue("history");
    expect(mockFetch).toHaveBeenLastCalledWith("/api/bookmarks?page=1&q=history");
  });

  it("renders OGP image thumbnail when ogpImageUrl is present", async () => {
    const bookmarkWithOgp = makeBookmark({ ogpImageUrl: "/ogp/test.png" });
    const bookmarkWithoutOgp = makeBookmark({ id: 2, title: "No OGP", ogpImageUrl: "" });

    mockFetch.mockResolvedValueOnce(bookmarksResponse([bookmarkWithOgp, bookmarkWithoutOgp]));

    render(<App />);

    // Wait for mock data to load
    await screen.findByRole("link", { name: "Example" });

    // Thumbnail should be rendered for the first one
    const thumbs = document.querySelectorAll(".bookmark-thumb");
    expect(thumbs.length).toBe(1);
    expect(thumbs[0]).toHaveAttribute("src", "/ogp/test.png");
    expect(thumbs[0]).toHaveAttribute("aria-hidden", "true");
    expect(thumbs[0]).toHaveAttribute("loading", "lazy");
  });
});
