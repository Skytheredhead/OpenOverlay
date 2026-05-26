import { describe, expect, it } from "vitest";
import { defaultSoccerPackageState, normalizeSoccerPackageState } from "./index.js";

describe("soccer package state", () => {
  it("keeps color edits isolated per overlay package", () => {
    const state = defaultSoccerPackageState();
    state.colorBanks.classic.panelGray = "#222222";
    state.colorBanks.rounded.maroon = "#123456";

    const normalized = normalizeSoccerPackageState({
      overlayPackage: "rounded",
      colorBanks: state.colorBanks
    });

    expect(normalized.colorBanks.classic.panelGray).toBe("#222222");
    expect(normalized.colorBanks.rounded.maroon).toBe("#123456");
  });

  it("fills missing color bank values without overwriting valid edits", () => {
    const normalized = normalizeSoccerPackageState({
      colorBanks: {
        classic: { panelGray: "#222222" },
        rounded: { maroon: "purple" }
      }
    });

    expect(normalized.colorBanks.classic.panelGray).toBe("#222222");
    expect(normalized.colorBanks.classic.bg).toBe("#ffffff");
    expect(normalized.colorBanks.rounded.maroon).toBe("#7a1235");
  });
});
