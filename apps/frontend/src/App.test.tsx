import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultChurchState, defaultTeam, type PresetListItem } from "@openoverlay/shared";
import { MemoryRouter } from "react-router-dom";
import { App, AuthProvider, ChurchControls, MediaLibrary, SyncedTimeInput, TeamFields, useAuth } from "./App";
import { ApiError, authApi, mediaApi, presetApi, statusApi, type MediaItem, type User } from "./lib/api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SyncedTimeInput", () => {
  it("reflects remote resets while idle without overwriting a focused draft", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <label>
        Clock
        <SyncedTimeInput seconds={75} onCommit={onCommit} />
      </label>
    );
    const input = screen.getByLabelText("Clock");
    expect(input).toHaveValue("01:15");

    rerender(
      <label>
        Clock
        <SyncedTimeInput seconds={30} onCommit={onCommit} />
      </label>
    );
    expect(input).toHaveValue("00:30");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "02:00" } });
    rerender(
      <label>
        Clock
        <SyncedTimeInput seconds={10} onCommit={onCommit} />
      </label>
    );
    expect(input).toHaveValue("02:00");

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(120);
  });

  it("keeps malformed text visible and does not silently commit zero", () => {
    const onCommit = vi.fn();
    render(
      <label>
        Clock
        <SyncedTimeInput seconds={75} onCommit={onCommit} />
      </label>
    );
    const input = screen.getByLabelText("Clock");

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1:60" } });
    fireEvent.blur(input);

    expect(input).toHaveValue("1:60");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "00:00" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("00:00");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(0);
  });
});

describe("ChurchControls", () => {
  it("drives lower-third and countdown actions with the selected slide and entered duration", () => {
    const state = createDefaultChurchState("Sunday");
    const commitState = vi.fn();
    const runAction = vi.fn(async () => undefined);
    render(<ChurchControls state={state} media={[]} tab="slides" commitState={commitState} runAction={runAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Show selected lower third" }));
    expect(runAction).toHaveBeenCalledWith("trigger-lower-third", {
      title: "Welcome",
      subtitle: "Welcome\nWe are glad you are here"
    });

    const countdown = screen.getByLabelText("Countdown length");
    fireEvent.focus(countdown);
    fireEvent.change(countdown, { target: { value: "01:30" } });
    fireEvent.blur(countdown);
    fireEvent.click(screen.getByRole("button", { name: "Start countdown" }));
    expect(runAction).toHaveBeenLastCalledWith("trigger-countdown", {
      title: "Service begins in",
      durationSeconds: 90
    });
  });

  it("persists church output visibility controls", () => {
    const state = createDefaultChurchState("Sunday");
    const commitState = vi.fn();
    render(<ChurchControls state={state} media={[]} tab="slides" commitState={commitState} runAction={vi.fn(async () => undefined)} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Show full-screen slide" }));
    expect(commitState).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: expect.objectContaining({
          fullscreenSlide: expect.objectContaining({ visible: false })
        })
      })
    );
  });
});

describe("TeamFields", () => {
  it("gives the existing-media logo selector an accessible name", () => {
    render(<TeamFields team={defaultTeam("home")} media={[mediaFixture()]} onChange={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "Choose existing logo from media library" })).toBeVisible();
  });
});

describe("MediaLibrary", () => {
  it("deduplicates overlapping batches and ignores an older list response", async () => {
    const initialList = deferred<{ media: MediaItem[]; nextCursor: string | null }>();
    const refreshedList = deferred<{ media: MediaItem[]; nextCursor: string | null }>();
    const upload = deferred<{ media: MediaItem }>();
    const item = mediaFixture();
    vi.spyOn(mediaApi, "list").mockReturnValueOnce(initialList.promise).mockReturnValueOnce(refreshedList.promise);
    const uploadSpy = vi.spyOn(mediaApi, "upload").mockReturnValue(upload.promise);

    const { unmount } = render(<MediaLibrary />);
    const dropzone = screen.getByText("Drop images here").closest("label");
    const file = new File(["image"], "badge.png", { type: "image/png" });
    expect(dropzone).not.toBeNull();

    fireEvent.drop(dropzone!, { dataTransfer: { files: [file] } });
    fireEvent.drop(dropzone!, { dataTransfer: { files: [file] } });
    expect(uploadSpy).toHaveBeenCalledOnce();
    expect(screen.getByText("Uploading images...")).toBeVisible();

    await act(async () => upload.resolve({ media: item }));
    await waitFor(() => expect(mediaApi.list).toHaveBeenCalledTimes(2));
    await act(async () => refreshedList.resolve({ media: [item], nextCursor: null }));
    expect(await screen.findByText(item.originalFilename)).toBeVisible();

    await act(async () => initialList.resolve({ media: [], nextCursor: null }));
    expect(screen.getByText(item.originalFilename)).toBeVisible();

    const signal = uploadSpy.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("AuthProvider", () => {
  it("ignores an older failed session probe after a newer refresh succeeds", async () => {
    const olderProbe = deferred<{ user: User }>();
    const freshUser: User = { id: "user-fresh", email: "operator@example.com" };
    vi.spyOn(authApi, "me").mockReturnValueOnce(olderProbe.promise).mockResolvedValueOnce({ user: freshUser });

    render(
      <MemoryRouter initialEntries={["/dash"]}>
        <AuthProvider>
          <AuthHarness />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(authApi.me).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh session" }));
    expect(await screen.findByText(freshUser.email)).toBeVisible();

    await act(async () => olderProbe.reject(new ApiError("Session expired", 401, { error: "Session expired" })));
    expect(screen.getByText(freshUser.email)).toBeVisible();
    expect(screen.queryByText("signed out")).not.toBeInTheDocument();
  });
});

describe("sidebar destructive concurrency", () => {
  it("deletes only the revision shown to the operator instead of accepting a newer unseen revision", async () => {
    const game: PresetListItem = {
      id: "preset-visible",
      publicId: "public-visible",
      name: "Visible Revision",
      type: "soccer",
      revision: 7,
      updatedAt: "2026-08-11T00:00:00.000Z",
      overlayClientCount: 0
    };
    vi.spyOn(authApi, "me").mockResolvedValue({ user: { id: "user-1", email: "operator@example.com" } });
    vi.spyOn(statusApi, "health").mockResolvedValue({ ok: true, app: "OpenOverlay", component: "backend", time: "2026-08-11T00:00:00.000Z" });
    vi.spyOn(presetApi, "list").mockResolvedValue({ presets: [game] });
    const getSpy = vi.spyOn(presetApi, "get");
    const removeSpy = vi.spyOn(presetApi, "remove").mockResolvedValue({ ok: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }))
    );

    render(
      <MemoryRouter initialEntries={["/dash"]}>
        <App />
      </MemoryRouter>
    );

    const sidebarGame = await screen.findByRole("link", { name: game.name });
    fireEvent.contextMenu(sidebarGame);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(game.id, game.revision));
    expect(getSpy).not.toHaveBeenCalled();
  });
});

function AuthHarness() {
  const { user, loading, error, refresh } = useAuth();
  return (
    <div>
      <p>{loading ? "loading" : (user?.email ?? "signed out")}</p>
      {error ? <p>{error}</p> : null}
      <button type="button" onClick={() => void refresh()}>
        Refresh session
      </button>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mediaFixture(): MediaItem {
  return {
    id: "media-1",
    publicId: "public-media-1",
    filename: "media-1-badge.png",
    originalFilename: "badge.png",
    mimeType: "image/png",
    width: 100,
    height: 100,
    sizeBytes: 5,
    createdAt: "2026-08-10T00:00:00.000Z",
    url: "/api/v1/media/file/public-media-1"
  };
}
