import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSoccerState, type PresetSummary } from "@openoverlay/shared";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router-dom";

interface FakeSocket {
  handlers: Map<string, Array<(payload?: unknown) => void>>;
  disconnect: ReturnType<typeof vi.fn>;
  emit(event: string, payload?: unknown): void;
}

const socketHarness = vi.hoisted(() => ({ sockets: [] as FakeSocket[] }));

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => {
    const handlers = new Map<string, Array<(payload?: unknown) => void>>();
    const socket = {
      handlers,
      on: vi.fn((event: string, callback: (payload?: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), callback]);
        return socket;
      }),
      disconnect: vi.fn(),
      emit(event: string, payload?: unknown) {
        for (const callback of handlers.get(event) ?? []) callback(payload);
      }
    } as FakeSocket & { on: ReturnType<typeof vi.fn> };
    socketHarness.sockets.push(socket);
    return socket;
  })
}));

import { OverlayPage, PresetEditor, PromptDialogProvider } from "./App";
import { mediaApi, overlayApi, presetApi, teamApi } from "./lib/api";

describe("preset deletion realtime handling", () => {
  beforeEach(() => {
    socketHarness.sockets.splice(0);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clears a public overlay, aborts its stale HTTP load, and stays cleared", async () => {
    const pendingOverlay = deferred<{ overlay: PresetSummary }>();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(overlayApi, "get").mockImplementation((_id, signal) => {
      requestSignal = signal;
      return pendingOverlay.promise;
    });

    render(
      <MemoryRouter initialEntries={["/overlay-test/public-1"]}>
        <Routes>
          <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(socketHarness.sockets).toHaveLength(1));
    const socket = socketHarness.sockets[0]!;
    act(() => socket.emit("preset:deleted", deletionEvent()));

    expect(await screen.findByRole("alert")).toHaveTextContent("This overlay was deleted and is no longer available.");
    expect(requestSignal?.aborted).toBe(true);
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(document.querySelector(".overlay-viewport")).not.toBeInTheDocument();

    await act(async () => pendingOverlay.resolve({ overlay: presetFixture() }));
    expect(screen.getByRole("alert")).toHaveTextContent("This overlay was deleted and is no longer available.");
    expect(document.querySelector(".overlay-viewport")).not.toBeInTheDocument();
  });

  it("replaces an editor with a terminal deleted state and ignores its late load", async () => {
    const pendingPreset = deferred<{ preset: PresetSummary }>();
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(presetApi, "get").mockImplementation((_id, signal) => {
      requestSignal = signal;
      return pendingPreset.promise;
    });
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [] });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter([{
      path: "/dash/presets/:presetId",
      element: <PromptDialogProvider><PresetEditor /></PromptDialogProvider>
    }], { initialEntries: ["/dash/presets/preset-1"] });

    render(<RouterProvider router={router} />);
    await waitFor(() => expect(socketHarness.sockets).toHaveLength(1));
    const socket = socketHarness.sockets[0]!;
    act(() => socket.emit("preset:deleted", deletionEvent()));

    expect(await screen.findByRole("heading", { name: "Game deleted" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("This game was deleted in another session");
    expect(screen.getByRole("link", { name: "Return to games" })).toHaveAttribute("href", "/dash");
    expect(requestSignal?.aborted).toBe(true);
    expect(socket.disconnect).toHaveBeenCalledOnce();

    await act(async () => pendingPreset.resolve({ preset: presetFixture() }));
    expect(screen.getByRole("heading", { name: "Game deleted" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Realtime Game" })).not.toBeInTheDocument();
  });

  it("clears a previously loaded overlay when reconnect reports it missing", async () => {
    vi.spyOn(overlayApi, "get").mockResolvedValue({ overlay: presetFixture() });
    render(
      <MemoryRouter initialEntries={["/overlay-test/public-1"]}>
        <Routes>
          <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(document.querySelector(".overlay-viewport")).toBeInTheDocument());
    const socket = socketHarness.sockets[0]!;

    act(() => {
      socket.emit("disconnect");
      socket.emit("connect");
    });
    act(() => socket.emit("error:message", { error: "Realtime connection failed" }));
    expect(document.querySelector(".overlay-viewport")).toBeInTheDocument();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Overlay not found", code: 404 }));
    expect(document.querySelector(".overlay-viewport")).toBeInTheDocument();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Overlay not found" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This overlay was deleted and is no longer available.");
    expect(document.querySelector(".overlay-viewport")).not.toBeInTheDocument();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it("closes a previously loaded editor when reconnect reports its preset missing", async () => {
    vi.spyOn(presetApi, "get").mockResolvedValue({ preset: presetFixture() });
    vi.spyOn(mediaApi, "list").mockResolvedValue({ media: [] });
    vi.spyOn(teamApi, "list").mockResolvedValue({ teams: [] });
    const router = createMemoryRouter([{
      path: "/dash/presets/:presetId",
      element: <PromptDialogProvider><PresetEditor /></PromptDialogProvider>
    }], { initialEntries: ["/dash/presets/preset-1"] });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Realtime Game" })).toBeVisible();
    const socket = socketHarness.sockets[0]!;

    act(() => {
      socket.emit("disconnect");
      socket.emit("connect");
    });
    act(() => socket.emit("error:message", { error: "Authentication required" }));
    expect(screen.getByRole("heading", { name: "Realtime Game" })).toBeVisible();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Preset not found", retryable: false }));
    expect(screen.getByRole("heading", { name: "Realtime Game" })).toBeVisible();
    expect(socket.disconnect).not.toHaveBeenCalled();

    act(() => socket.emit("error:message", { error: "Preset not found" }));
    expect(await screen.findByRole("heading", { name: "Game deleted" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Realtime Game" })).not.toBeInTheDocument();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });
});

function deletionEvent() {
  return { id: "preset-1", publicId: "public-1", revision: 3 };
}

function presetFixture(): PresetSummary {
  return {
    id: "preset-1",
    publicId: "public-1",
    name: "Realtime Game",
    type: "soccer",
    revision: 2,
    updatedAt: "2026-08-11T00:00:00.000Z",
    state: createDefaultSoccerState("Realtime Game")
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
