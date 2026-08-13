import { describe, expect, it } from "vitest";
import { createDefaultChurchState, createDefaultSoccerState, computeClockSeconds, normalizeSoccerState, parseRoster } from "@openoverlay/shared";
import { PresetActionValidationError, applyAction, isSoccerState, materializeState, validatePresetState } from "../state.js";

describe("backend state actions", () => {
  it("updates scores through action endpoints logic", () => {
    let state = createDefaultSoccerState("Match");
    state = applyAction(state, "home-score-plus") as typeof state;
    state = applyAction(state, "away-score-plus") as typeof state;
    state = applyAction(state, "away-score-minus") as typeof state;
    expect(state.score).toEqual({ home: 1, away: 0 });
  });

  it("starts, pauses, and materializes stopped clocks", () => {
    let state = createDefaultSoccerState("Match");
    state.clock.stopAtEnabled = true;
    state.clock.stopAtSeconds = 10;
    state = applyAction(state, "clock-toggle", {}, 1_000) as typeof state;
    expect(state.clock.running).toBe(true);
    expect(computeClockSeconds(state.clock, 6_000)).toBe(5);
    const stopped = materializeState(state, 20_000);
    expect(isSoccerState(stopped)).toBe(true);
    if (isSoccerState(stopped)) {
      expect(stopped.clock.running).toBe(false);
      expect(stopped.clock.baseSeconds).toBe(10);
    }
  });

  it("toggles lab overlays and clears them", () => {
    let state = createDefaultSoccerState("Match");
    state = applyAction(state, "show-overlay", { overlay: "scorebug" }, 1_000) as typeof state;
    expect(state.soccerPackage.activeOverlay).toBe("scorebug");
    expect(state.soccerPackage.selectedOverlay).toBe("scorebug");
    state = applyAction(state, "hide-overlay", { overlay: "scorebug" }, 2_000) as typeof state;
    expect(state.soccerPackage.activeOverlay).toBeNull();
    state = applyAction(state, "show-overlay", { overlay: "lower-result" }, 3_000) as typeof state;
    state = applyAction(state, "clear", {}, 4_000) as typeof state;
    expect(state.soccerPackage.activeOverlay).toBeNull();
  });

  it("starts, stops, resets, and materializes package countdowns", () => {
    let state = createDefaultSoccerState("Match");
    state.soccerPackage.countdown.seconds = 10;
    state.soccerPackage.countdown.resetSeconds = 10;
    state = applyAction(state, "countdown-start", {}, 1_000) as typeof state;
    expect(state.soccerPackage.countdown.running).toBe(true);
    state = materializeState(state, 20_000) as typeof state;
    expect(state.soccerPackage.countdown.running).toBe(false);
    expect(state.soccerPackage.countdown.seconds).toBe(0);
    state = applyAction(state, "countdown-reset", {}, 21_000) as typeof state;
    expect(state.soccerPackage.countdown.seconds).toBe(10);
  });

  it("pages lineup overlays", () => {
    let state = createDefaultSoccerState("Match");
    state.home.rosterText = "1 A\n2 B\n3 C\n4 D\n5 E\n6 F\n7 G";
    state.home.roster = [
      { id: "1", line: "1 A", number: "1", name: "A", starter: false },
      { id: "2", line: "2 B", number: "2", name: "B", starter: false },
      { id: "3", line: "3 C", number: "3", name: "C", starter: false },
      { id: "4", line: "4 D", number: "4", name: "D", starter: false },
      { id: "5", line: "5 E", number: "5", name: "E", starter: false },
      { id: "6", line: "6 F", number: "6", name: "F", starter: false },
      { id: "7", line: "7 G", number: "7", name: "G", starter: false }
    ];
    state = applyAction(state, "lineup-next") as typeof state;
    expect(state.soccerPackage.activeOverlay).toBe("lineup-panel");
    expect(state.soccerPackage.lineupPage).toBe(1);
  });

  it.each([
    ["trigger-goal", "goal"],
    ["trigger-yellow-card", "yellow-card"],
    ["trigger-red-card", "red-card"],
    ["trigger-substitution", "substitution"],
    ["trigger-halftime", "halftime"],
    ["trigger-full-time", "fullscreen"],
    ["trigger-lineups", "lineups"],
    ["trigger-sponsor", "sponsor"],
    ["trigger-lower-third", "lower-third"]
  ] as const)("restores %s as an active %s graphic", (action, kind) => {
    const state = applyAction(createDefaultSoccerState("Match"), action, {}, 1_000);
    expect(state.activeGraphics.some((graphic) => graphic.kind === kind)).toBe(true);
  });

  it("rejects non-finite, negative, fractional, and excessive graphic durations", () => {
    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 3_601]) {
      expect(() => applyAction(createDefaultSoccerState("Match"), "trigger-goal", { durationSeconds })).toThrow(PresetActionValidationError);
    }
    const permanent = applyAction(createDefaultSoccerState("Match"), "trigger-goal", { durationSeconds: 0 });
    expect(permanent.activeGraphics[0]?.expiresAtMs).toBeNull();
  });

  it("keeps roster identities deterministic across parsing and normalization", () => {
    const rosterText = "1 Avery Stone\n1 Avery Stone\n7 Max Grenham";
    expect(parseRoster(rosterText).map((player) => player.id)).toEqual(parseRoster(rosterText).map((player) => player.id));
    const state = createDefaultSoccerState("Match");
    state.home.rosterText = rosterText;
    expect(normalizeSoccerState(state).home.roster.map((player) => player.id)).toEqual(normalizeSoccerState(state).home.roster.map((player) => player.id));
  });

  it("validates the roster derived from rosterText instead of trusting a stale roster array", () => {
    const state = createDefaultSoccerState("Roster boundary");
    state.home.rosterText = Array.from({ length: 251 }, (_, index) => `${index} Player ${index}`).join("\n");

    expect(state.home.roster).toHaveLength(5);
    expect(() => validatePresetState("soccer", "Roster boundary", state)).toThrow("state.home.roster has too many items");
  });

  it("validates optional soccer text-animation fields", () => {
    const valid = createDefaultSoccerState("Animation boundary");
    valid.soccerPackage.textAnimation = { id: 0, fields: ["home-score", "away-score"] };
    expect(validatePresetState("soccer", "Animation boundary", valid)).toMatchObject({
      soccerPackage: { textAnimation: { id: 0, fields: ["home-score", "away-score"] } }
    });

    const invalidAnimations: unknown[] = [
      { id: -1, fields: ["home-score"] },
      { id: 1.5, fields: ["home-score"] },
      { id: Number.MAX_SAFE_INTEGER + 1, fields: ["home-score"] },
      { id: 1, fields: ["not-a-field"] },
      { id: 1, fields: ["home-score", "home-score"] },
      { id: 1, fields: Array.from({ length: 19 }, () => "home-score") }
    ];
    for (const textAnimation of invalidAnimations) {
      const state = createDefaultSoccerState("Animation boundary");
      (state.soccerPackage as unknown as Record<string, unknown>).textAnimation = textAnimation;
      expect(() => validatePresetState("soccer", "Animation boundary", state)).toThrow();
    }
  });

  it("validates optional active-graphic team and payload fields", () => {
    const valid = applyAction(createDefaultSoccerState("Graphic boundary"), "trigger-goal", {
      title: "Goal",
      team: "home",
      durationSeconds: 0
    });
    expect(() => validatePresetState("soccer", "Graphic boundary", valid)).not.toThrow();

    for (const [field, value] of [
      ["team", "visitor"],
      ["payload", []],
      ["payload", null]
    ] as const) {
      const state = structuredClone(valid);
      (state.activeGraphics[0] as unknown as Record<string, unknown>)[field] = value;
      expect(() => validatePresetState("soccer", "Graphic boundary", state)).toThrow();
    }
  });

  it("validates optional overlay-element accent colors and fonts", () => {
    const valid = createDefaultSoccerState("Element boundary");
    valid.elements.scorebug.accentColor = "#abcdef";
    valid.elements.scorebug.font = "Inter Variable";
    expect(() => validatePresetState("soccer", "Element boundary", valid)).not.toThrow();

    for (const [field, value] of [
      ["accentColor", "red"],
      ["accentColor", 123456],
      ["font", 42],
      ["font", "x".repeat(201)]
    ] as const) {
      const state = createDefaultSoccerState("Element boundary");
      (state.elements.scorebug as unknown as Record<string, unknown>)[field] = value;
      expect(() => validatePresetState("soccer", "Element boundary", state)).toThrow();
    }
  });

  it("starts and stops a real church countdown instead of showing a wall clock", () => {
    let state = createDefaultChurchState("Sunday");
    state = applyAction(state, "trigger-countdown", { title: "Service starts", durationSeconds: 90 }, 1_000) as typeof state;
    expect(state.activeGraphics).toEqual([
      expect.objectContaining({
        kind: "countdown",
        title: "Service starts",
        startedAtMs: 1_000,
        durationMs: 90_000,
        expiresAtMs: 91_000
      })
    ]);

    state = applyAction(state, "countdown-stop", {}, 2_000) as typeof state;
    expect(state.activeGraphics).toEqual([]);
    expect(() => applyAction(state, "countdown-start", { durationSeconds: 0 }, 3_000)).toThrow(PresetActionValidationError);
  });

  it("toggles a persistent church lower third using the selected slide as its fallback copy", () => {
    let state = createDefaultChurchState("Sunday");
    state = applyAction(state, "trigger-lower-third", {}, 1_000) as typeof state;
    expect(state.activeGraphics).toEqual([
      expect.objectContaining({
        kind: "church-lower-third",
        title: "Welcome",
        subtitle: "Welcome\nWe are glad you are here",
        expiresAtMs: null
      })
    ]);
    state = applyAction(state, "trigger-lower-third", {}, 2_000) as typeof state;
    expect(state.activeGraphics).toEqual([]);
  });

  it("migrates the legacy full-screen church slide offset without disturbing custom placement", () => {
    const legacy = createDefaultChurchState("Legacy");
    legacy.elements.fullscreenSlide.placement.y = 42;
    const migrated = validatePresetState("church", "Legacy", legacy);
    expect("slides" in migrated && migrated.elements.fullscreenSlide.placement.y).toBe(0);

    legacy.elements.fullscreenSlide.placement.y = 100;
    const custom = validatePresetState("church", "Legacy", legacy);
    expect("slides" in custom && custom.elements.fullscreenSlide.placement.y).toBe(100);
  });

  it("rejects an action that would move a valid state outside domain limits", () => {
    const state = createDefaultSoccerState("Boundary");
    state.score.home = 1_000_000;

    expect(() => applyAction(state, "home-score-plus", {}, 1_000)).toThrow(/non-negative integer/);
    expect(state.score.home).toBe(1_000_000);
  });
});
