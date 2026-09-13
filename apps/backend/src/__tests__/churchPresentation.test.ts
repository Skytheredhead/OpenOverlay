import { describe, expect, it } from "vitest";
import { createDefaultChurchState, type ChurchState } from "@openoverlay/shared";
import { applyAction, validatePresetState } from "../state.js";

describe("church presentation validation", () => {
  it("persists output modes and slide typography including the live snapshot", () => {
    const state = createDefaultChurchState();
    state.blackout = true;
    state.textCleared = true;
    state.stageMessage = "Two minutes remaining";
    Object.assign(state.slides[0], {
      fontSize: 76,
      textAlign: "left",
      backgroundDim: 40,
      backgroundPreset: "aurora",
      backgroundMotion: true,
      reference: "Reading",
      label: "Verse 1",
      notes: "Cue speaker"
    });
    state.onAirSlide = structuredClone(state.slides[0]);
    expect(validatePresetState("church", "Sunday", state)).toEqual(state);
  });
  it("rejects malformed optional fields and duplicate slide IDs", () => {
    const state = createDefaultChurchState();
    for (const patch of [{ blackout: "yes" }, { textCleared: 1 }, { stageMessage: "x".repeat(501) }, { slides: [state.slides[0], state.slides[0]] }]) {
      expect(() => validatePresetState("church", "Sunday", { ...state, ...patch })).toThrow();
    }
    for (const patch of [
      { backgroundPreset: "unknown" },
      { backgroundMotion: "yes" },
      { fontSize: 0 },
      { fontSize: "76" },
      { backgroundDim: 91 },
      { textAlign: "top" },
      { notes: "x".repeat(2001) }
    ]) {
      expect(() => validatePresetState("church", "Sunday", { ...state, onAirSlide: { ...state.slides[0], ...patch } })).toThrow();
    }
  });
  it("panic clear removes blackout and all audience layers", () => {
    const state = createDefaultChurchState();
    state.blackout = true;
    state.textCleared = true;
    const cleared = applyAction(state, "clear") as ChurchState;
    expect(cleared.blackout).toBe(false);
    expect(cleared.textCleared).toBe(false);
    expect(cleared.elements.fullscreenSlide.visible).toBe(false);
    expect(cleared.activeGraphics).toEqual([]);
  });
});
