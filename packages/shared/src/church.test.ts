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

describe("service preparation", () => {
  it("splits songs into readable slides while preserving group labels and copyright", async () => {
    const { prepareChurchSlides } = await import("./index.js");
    const slides = prepareChurchSlides(
      "[Verse 1]\nFirst line\nSecond line\nThird line\n\n[Chorus]\nSing together\nSing again",
      "Opening song",
      2,
      "Original lyrics"
    );
    expect(slides.map((slide) => [slide.label, slide.text])).toEqual([
      ["Verse 1", "First line\nSecond line"],
      ["Verse 1", "Third line"],
      ["Chorus", "Sing together\nSing again"]
    ]);
    expect(new Set(slides.map((slide) => slide.id)).size).toBe(3);
    expect(slides.every((slide) => slide.reference === "Original lyrics")).toBe(true);
    expect(() => prepareChurchSlides("x".repeat(10001), "Song")).toThrow(/10,000/);
  });
  it("orders items without losing legacy orphaned slides", async () => {
    const { orderedChurchSlides } = await import("./index.js");
    const state = createDefaultChurchState();
    state.slides = [
      { ...state.slides[0], id: "a", section: "Message" },
      { ...state.slides[0], id: "b", section: "Worship" },
      { ...state.slides[0], id: "c", section: "Legacy" }
    ];
    expect(orderedChurchSlides(state).map((slide) => slide.id)).toEqual(["b", "a", "c"]);
  });
  it("round trips portable service content with fresh IDs and no media URLs or live state", async () => {
    const { importChurchService, exportChurchService } = await import("./index.js");
    const state = createDefaultChurchState();
    state.slides[0].mediaUrl = "https://private.example/image";
    state.slides[0].notes = "Cue speaker";
    state.slides[0].backgroundPreset = "geometry";
    state.slides[0].backgroundMotion = false;
    state.stageMessage = "Live message";
    const exported = exportChurchService(state);
    const restored = importChurchService(exported);
    expect(restored.slides[0].text).toBe(state.slides[0].text);
    expect(restored.slides[0].notes).toBe("Cue speaker");
    expect(restored.slides[0].backgroundPreset).toBe("geometry");
    expect(restored.slides[0].backgroundMotion).toBe(false);
    expect(restored.slides[0].id).not.toBe(state.slides[0].id);
    expect(exported).not.toContain("private.example");
    expect(exported).not.toContain("Live message");
    expect(() => importChurchService('{"format":"other"}')).toThrow();
    expect(() => importChurchService(exported.replace('"backgroundColor": "#111827"', '"backgroundColor": "red"'))).toThrow();
  });
});
