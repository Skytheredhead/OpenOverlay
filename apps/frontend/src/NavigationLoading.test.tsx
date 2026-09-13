import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaLibrary } from "./App";
import { mediaApi } from "./lib/api";

afterEach(() => vi.restoreAllMocks());

describe("navigation loading", () => {
  it("keeps media placeholders until the request settles and clears them for an empty library", async () => {
    let resolve!: (value: { media: []; nextCursor: null }) => void;
    vi.spyOn(mediaApi, "list").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<MediaLibrary />);
    expect(screen.getByRole("status", { name: "Loading media" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("Upload media files")).toBeEnabled();
    await act(async () => resolve({ media: [], nextCursor: null }));
    expect(screen.queryByRole("status", { name: "Loading media" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces placeholders with a retryable error on repeated failures", async () => {
    const list = vi.spyOn(mediaApi, "list").mockRejectedValue(new Error("Media unavailable"));
    render(<MediaLibrary />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Media unavailable");
    expect(screen.queryByRole("status", { name: "Loading media" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry media" }));
    expect(screen.getByRole("status", { name: "Loading media" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("Media unavailable");
    expect(screen.queryByRole("status", { name: "Loading media" })).not.toBeInTheDocument();
    list.mockResolvedValue({ media: [], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Retry media" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading media" })).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
