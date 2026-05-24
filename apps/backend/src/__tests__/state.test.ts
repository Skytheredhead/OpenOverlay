import { describe, expect, it } from "vitest";
import { createDefaultSoccerState, computeClockSeconds } from "@openoverlay/shared";
import { applyAction, isSoccerState, materializeState } from "../state.js";

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

  it("toggles graphics and clears them", () => {
    let state = createDefaultSoccerState("Match");
    state = applyAction(state, "trigger-goal", { title: "Goal Max", durationSeconds: 5 }, 1_000) as typeof state;
    expect(state.activeGraphics).toHaveLength(1);
    state = applyAction(state, "trigger-goal", { title: "Goal Max", durationSeconds: 5 }, 2_000) as typeof state;
    expect(state.activeGraphics).toHaveLength(0);
    state = applyAction(state, "trigger-yellow-card", {}, 3_000) as typeof state;
    state = applyAction(state, "clear", {}, 4_000) as typeof state;
    expect(state.activeGraphics).toHaveLength(0);
  });
});
