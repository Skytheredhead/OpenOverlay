import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENOVERLAY_API_VERSION, createDefaultSoccerState } from "@openoverlay/shared";
import { AUTH_EXPIRED_EVENT, ApiError, api, authApi, isPreset, isPresetDeletedEvent, isRealtimeErrorMessage, presetApi, teamApi } from "./api";

describe("api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves caller headers while enforcing JSON and API-version headers", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Custom")).toBe("yes");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-OpenOverlay-Api-Version")).toBe(OPENOVERLAY_API_VERSION);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api<{ ok: true }>("/test", { method: "POST", headers: { "X-Custom": "yes" }, body: "{}" })).resolves.toEqual({ ok: true });
  });

  it("reports malformed JSON deterministically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 502, headers: { "Content-Type": "application/json" } }))
    );

    await expect(api("/test")).rejects.toMatchObject({ status: 502, message: "Server returned malformed JSON (502)" } satisfies Partial<ApiError>);
  });

  it("expires authentication even when a 401 response has malformed JSON", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("truncated", { status: 401, headers: { "Content-Type": "application/json" } }))
    );
    try {
      await expect(api("/api/presets")).rejects.toMatchObject({ status: 401 });
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
    }
  });

  it("does not let a delayed 401 from an old session expire a successful new login", async () => {
    let rejectOldSession!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      rejectOldSession = resolve;
    });
    const expired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(oldResponse)
        .mockResolvedValueOnce(jsonResponse({ user: { id: "new-user", email: "new@example.com" } }))
    );
    try {
      const oldRequest = api("/api/presets");
      const rejection = expect(oldRequest).rejects.toMatchObject({ status: 401 });
      await authApi.login("new@example.com", "password");
      rejectOldSession(new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } }));
      await rejection;
      expect(expired).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
    }
  });

  it("accepts an empty successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    );

    await expect(api<void>("/test", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("rejects empty and non-JSON success responses instead of returning invalid data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/empty")).rejects.toMatchObject({ status: 200, message: "Server returned an empty response (200)" } satisfies Partial<ApiError>);
    await expect(api("/text")).rejects.toMatchObject({ status: 200, message: "Server returned a non-JSON response (200)" } satisfies Partial<ApiError>);
  });

  it("fails a stalled request with a bounded timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          })
      )
    );

    try {
      const rejection = expect(api("/stalled")).rejects.toMatchObject({
        status: 0,
        message: "Request timed out after 20 seconds"
      } satisfies Partial<ApiError>);
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed endpoint envelopes before UI code can consume them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ presets: {} }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(presetApi.list()).rejects.toMatchObject({ status: 0, message: "Server response did not include a valid presets" } satisfies Partial<ApiError>);
    await expect(authApi.me()).rejects.toMatchObject({ status: 0, message: "Server response did not include a valid user" } satisfies Partial<ApiError>);
    await expect(authApi.logout()).rejects.toMatchObject({ status: 0, message: "Server response did not confirm the operation" } satisfies Partial<ApiError>);
  });

  it("accepts a privacy-preserving share receipt and rejects the legacy recipient preset envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, mediaReferencesRemoved: true, receiptId: "receipt-1" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, preset: { id: "recipient-copy" }, mediaReferencesRemoved: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(presetApi.share("source", "recipient@example.com")).resolves.toEqual({ ok: true, mediaReferencesRemoved: true, receiptId: "receipt-1" });
    await expect(presetApi.share("source", "recipient@example.com")).rejects.toMatchObject({
      status: 0,
      message: "Server response did not confirm the share operation"
    } satisfies Partial<ApiError>);
  });

  it("accepts bounded list summaries without state", async () => {
    const item = {
      id: "preset-1",
      publicId: "public-1",
      name: "Summary",
      type: "soccer",
      revision: 2,
      updatedAt: "2026-08-10T00:00:00.000Z",
      overlayClientCount: 1
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ presets: [item] }))
    );

    await expect(presetApi.list()).resolves.toEqual({ presets: [item] });
  });

  it("sends the expected revision in If-Match for destructive preset and team requests", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(presetApi.remove("preset-1", 7)).resolves.toEqual({ ok: true });
    await expect(teamApi.remove("team-1", 3)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, init]) => ({
        method: init?.method,
        ifMatch: new Headers(init?.headers).get("If-Match")
      }))
    ).toEqual([
      { method: "DELETE", ifMatch: '"7"' },
      { method: "DELETE", ifMatch: '"3"' }
    ]);
  });

  it("strictly validates preset deletion events before realtime handlers consume them", () => {
    expect(isPresetDeletedEvent({ id: "preset-1", publicId: "public-1", revision: 4 })).toBe(true);
    expect(isPresetDeletedEvent({ id: "preset-1", publicId: "public-1", revision: 0 })).toBe(false);
    expect(isPresetDeletedEvent({ id: "preset-1", publicId: "public-1", revision: 4.5 })).toBe(false);
    expect(isPresetDeletedEvent({ id: "preset-1", publicId: "", revision: 4 })).toBe(false);
    expect(isPresetDeletedEvent({ id: "preset-1", publicId: "public-1", revision: 4, unexpected: true })).toBe(false);
  });

  it("strictly validates realtime error messages", () => {
    expect(isRealtimeErrorMessage({ error: "Preset not found" })).toBe(true);
    expect(isRealtimeErrorMessage({ error: "" })).toBe(false);
    expect(isRealtimeErrorMessage({ error: "Unknown realtime failure" })).toBe(false);
    expect(isRealtimeErrorMessage({ error: 404 })).toBe(false);
    expect(isRealtimeErrorMessage({ error: "Preset not found", code: 404 })).toBe(false);
  });

  it("rejects malformed realtime preset shapes before they reach UI state", () => {
    const valid = validSoccerPreset();
    expect(isPreset(valid)).toBe(true);
    expect(isPreset({ ...valid, revision: undefined })).toBe(false);
    expect(isPreset({ ...valid, state: { ...valid.state, activeGraphics: undefined } })).toBe(false);
    expect(isPreset({ ...valid, state: { ...valid.state, soccerPackage: {} } })).toBe(false);
  });

  it("rejects soccer presets missing any required overlay element", () => {
    const requiredElementKeys = ["scorebug", "statBug", "sponsorBug", "lowerThird", "countdown", "fullscreen"] as const;

    for (const missingKey of requiredElementKeys) {
      const valid = validSoccerPreset();
      const { [missingKey]: _missing, ...elements } = valid.state.elements;

      expect(isPreset({ ...valid, state: { ...valid.state, elements } }), `missing elements.${missingKey}`).toBe(false);
    }
  });

  it("rejects null and malformed soccer roster entries", () => {
    const valid = validSoccerPreset();
    const player = valid.state.home.roster[0];
    const malformedEntries: Array<[string, unknown]> = [
      ["null entry", null],
      ["missing name", { ...player, name: undefined }],
      ["non-boolean starter", { ...player, starter: "yes" }],
      ["non-string optional number", { ...player, number: 7 }],
      ["non-string optional position", { ...player, position: null }]
    ];

    for (const [description, entry] of malformedEntries) {
      expect(
        isPreset({
          ...valid,
          state: {
            ...valid.state,
            home: { ...valid.state.home, roster: [entry] }
          }
        }),
        description
      ).toBe(false);
    }

    expect(
      isPreset({
        ...valid,
        state: {
          ...valid.state,
          away: { ...valid.state.away, roster: [null] }
        }
      }),
      "away roster is validated too"
    ).toBe(false);
  });

  it("rejects non-string optional soccer team logo URLs", () => {
    for (const logoUrl of [null, 42, {}, []]) {
      const valid = validSoccerPreset();
      expect(
        isPreset({
          ...valid,
          state: {
            ...valid.state,
            home: { ...valid.state.home, logoUrl }
          }
        })
      ).toBe(false);
    }
  });

  it("rejects invalid soccer-package enums", () => {
    const valid = validSoccerPreset();
    const soccerPackage = valid.state.soccerPackage;
    const invalidPackages: Array<[string, unknown]> = [
      [
        "overlayPackage",
        {
          ...soccerPackage,
          overlayPackage: "legacy",
          colorBanks: { ...soccerPackage.colorBanks, legacy: { bg: "#000000" } }
        }
      ],
      ["activeOverlay", { ...soccerPackage, activeOverlay: "sponsor-bug" }],
      ["selectedOverlay", { ...soccerPackage, selectedOverlay: "sponsor-bug" }],
      ["surface", { ...soccerPackage, surface: "transparent" }],
      ["scorebugLayout", { ...soccerPackage, scorebugLayout: "diagonal" }],
      ["lowerResultState", { ...soccerPackage, lowerResultState: "OVERTIME" }],
      ["oneLinePosition", { ...soccerPackage, oneLinePosition: "middle-left" }],
      ["twoLinePosition", { ...soccerPackage, twoLinePosition: "middle-right" }],
      ["lineupTeam", { ...soccerPackage, lineupTeam: "neutral" }],
      [
        "countdown.mode",
        {
          ...soccerPackage,
          countdown: { ...soccerPackage.countdown, mode: "compact" }
        }
      ],
      [
        "countdown.position",
        {
          ...soccerPackage,
          countdown: { ...soccerPackage.countdown, position: "middle-center" }
        }
      ]
    ];

    for (const [description, malformedPackage] of invalidPackages) {
      expect(
        isPreset({
          ...valid,
          state: { ...valid.state, soccerPackage: malformedPackage }
        }),
        description
      ).toBe(false);
    }
  });

  it("rejects incomplete and non-string soccer-package color banks", () => {
    const valid = validSoccerPreset();
    const soccerPackage = valid.state.soccerPackage;
    const { ink: _missingInk, ...roundedWithoutInk } = soccerPackage.colorBanks.rounded;

    expect(
      isPreset({
        ...valid,
        state: {
          ...valid.state,
          soccerPackage: {
            ...soccerPackage,
            colorBanks: { ...soccerPackage.colorBanks, rounded: roundedWithoutInk }
          }
        }
      })
    ).toBe(false);
    expect(
      isPreset({
        ...valid,
        state: {
          ...valid.state,
          soccerPackage: {
            ...soccerPackage,
            colorBanks: {
              ...soccerPackage.colorBanks,
              classic: { ...soccerPackage.colorBanks.classic, panelGray: null }
            }
          }
        }
      })
    ).toBe(false);
  });

  it("validates optional soccer text-animation payloads deeply", () => {
    const valid = validSoccerPreset();
    const soccerPackage = valid.state.soccerPackage;
    const withTextAnimation = (textAnimation: unknown) => ({
      ...valid,
      state: {
        ...valid.state,
        soccerPackage: { ...soccerPackage, textAnimation }
      }
    });

    expect(isPreset(withTextAnimation({ id: 1, fields: ["event-title", "home-score"] }))).toBe(true);
    expect(isPreset(withTextAnimation(null))).toBe(false);
    expect(isPreset(withTextAnimation({ id: "1", fields: ["home-score"] }))).toBe(false);
    expect(isPreset(withTextAnimation({ id: 1, fields: "home-score" }))).toBe(false);
    expect(isPreset(withTextAnimation({ id: 1, fields: ["unknown-field"] }))).toBe(false);
  });

  it("does not expire a fresh session when an older auth probe or login returns 401", async () => {
    const authExpired = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, authExpired);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          })
      )
    );

    try {
      await expect(authApi.me()).rejects.toMatchObject({ status: 401 });
      await expect(authApi.login("operator@example.com", "wrong-password")).rejects.toMatchObject({ status: 401 });
      expect(authExpired).not.toHaveBeenCalled();

      await expect(api("/api/presets")).rejects.toMatchObject({ status: 401 });
      expect(authExpired).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(AUTH_EXPIRED_EVENT, authExpired);
    }
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function validSoccerPreset() {
  return {
    id: "preset-1",
    publicId: "public-1",
    name: "Game",
    type: "soccer" as const,
    revision: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
    state: createDefaultSoccerState("Game")
  };
}
