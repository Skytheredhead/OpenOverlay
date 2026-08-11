import { describe, expect, it } from "vitest";
import { createDefaultChurchState, normalizeChurchState } from "./index.js";

describe("church state", () => {
  it("places new full-screen slides at the stage origin", () => {
    const state = createDefaultChurchState("Sunday");
    expect(state.elements.fullscreenSlide.placement).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      scale: 1,
      preset: "custom"
    });
  });

  it("only repairs the exact legacy full-screen placement", () => {
    const legacy = createDefaultChurchState("Sunday");
    legacy.elements.fullscreenSlide.placement.y = 42;
    expect(normalizeChurchState(legacy).elements.fullscreenSlide.placement.y).toBe(0);

    const intentionallyPlaced = createDefaultChurchState("Sunday");
    intentionallyPlaced.elements.fullscreenSlide.placement.y = 43;
    expect(normalizeChurchState(intentionallyPlaced)).toBe(intentionallyPlaced);
  });
});
