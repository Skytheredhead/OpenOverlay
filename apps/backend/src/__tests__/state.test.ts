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
});
