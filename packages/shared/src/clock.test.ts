import { describe, expect, it } from "vitest";
import {
  computeClockSeconds,
  createDefaultSoccerState,
  defaultClock,
  formatClock,
  normalizeSoccerState,
  parseClockTime,
  pauseClock,
  resetClock,
  setClockSeconds,
  startClock,
  tryParseClockTime
} from "./index.js";

describe("soccer clock", () => {
  it("counts up and respects stop-at when enabled", () => {
    const started = startClock({ ...defaultClock(), stopAtSeconds: 45 * 60 }, 1_000);
    expect(computeClockSeconds(started, 11_000)).toBe(10);
    expect(computeClockSeconds(started, 3_000_000)).toBe(45 * 60);
  });

  it("counts past stop-at when disabled", () => {
    const started = startClock({ ...defaultClock(), stopAtEnabled: false }, 1_000);
    expect(computeClockSeconds(started, 3_000_000)).toBe(2_999);
  });

  it("counts down and stops at configured stop time", () => {
    const clock = {
      ...defaultClock(),
      mode: "down" as const,
      baseSeconds: 10 * 60,
      resetSeconds: 10 * 60,
      stopAtEnabled: true,
      stopAtSeconds: 2 * 60
    };
    const started = startClock(clock, 2_000);
    expect(computeClockSeconds(started, 62_000)).toBe(9 * 60);
    expect(computeClockSeconds(started, 1_000_000)).toBe(2 * 60);
  });

  it("preserves elapsed time across pause and resume", () => {
    const firstRun = startClock(defaultClock(), 1_000);
    const paused = pauseClock(firstRun, 16_000);
    expect(paused.baseSeconds).toBe(15);
    const secondRun = startClock(paused, 20_000);
    expect(computeClockSeconds(secondRun, 25_000)).toBe(20);
  });

  it("resets and manually sets time", () => {
    const clock = setClockSeconds(defaultClock(), 123);
    expect(clock.baseSeconds).toBe(123);
    expect(resetClock({ ...clock, baseSeconds: 200, running: true, startedAtMs: 1_000 }).baseSeconds).toBe(123);
  });

  it("normalizes soccer package and team image crop defaults", () => {
    const state = createDefaultSoccerState("Match");
    delete (state.home as Partial<typeof state.home>).imageCrop;
    delete (state as Partial<typeof state>).soccerPackage;
    const normalized = normalizeSoccerState(state);
    expect(normalized.home.imageCrop).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(normalized.soccerPackage.overlayPackage).toBe("classic");
    expect(normalized.soccerPackage.activeOverlay).toBe("full-matchup");
  });

  it("strictly parses clock input without accepting junk or ambiguous overflow", () => {
    expect(tryParseClockTime("0")).toBe(0);
    expect(tryParseClockTime("00:00")).toBe(0);
    expect(parseClockTime("90:00")).toBe(5_400);
    expect(parseClockTime("1:2")).toBe(62);
    expect(parseClockTime("75")).toBe(75);
    for (const invalid of ["", " ", "1abc", "1:60", "1:2:3", "-1", "1.5", ":30", "1:", "1000001"]) {
      expect(tryParseClockTime(invalid)).toBeNull();
      expect(parseClockTime(invalid)).toBe(0);
    }
  });

  it("round-trips formatted clock values across deterministic boundary samples", () => {
    let seed = 0x5eed1234;
    const samples = [0, 1, 59, 60, 61, 3_599, 5_400, 35_999, 1_000_000];
    for (let index = 0; index < 1_000; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      samples.push(seed % 1_000_001);
    }
    for (const seconds of samples) expect(parseClockTime(formatClock(seconds))).toBe(seconds);
    expect(formatClock(Number.NaN)).toBe("00:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("00:00");
  });
});
