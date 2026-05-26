import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDefaultChurchState, createDefaultSoccerState } from "@openoverlay/shared";
import { OverlayRenderer } from "./OverlayRenderer";

function frameBody(container: HTMLElement) {
  return container.querySelector<HTMLIFrameElement>(".lab-frame")?.contentDocument?.body || null;
}

async function frameText(container: HTMLElement) {
  await waitFor(() => expect(frameBody(container)?.textContent || "").not.toBe(""));
  return frameBody(container)?.textContent || "";
}

describe("OverlayRenderer", () => {
  it("renders the Classic soccer matchup package", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.score.home = 3;
    state.score.away = 2;
    const { container } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    await expect(frameText(container)).resolves.toContain("Test Match");
    await expect(frameText(container)).resolves.toContain("OpenOverlay United");
    await expect(frameText(container)).resolves.toContain("Skyline FC");
    await expect(frameText(container)).resolves.toContain("05:00");
  });

  it("renders the Rounded scorebug package with team abbreviations", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.overlayPackage = "rounded";
    state.soccerPackage.activeOverlay = "scorebug";
    const { container } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    await expect(frameText(container)).resolves.toContain("OOU");
    await expect(frameText(container)).resolves.toContain("SKY");
  });

  it("keeps a soccer overlay mounted with the exit class after hiding it", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.activeOverlay = "full-matchup";
    const { container, rerender } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-entering")).toBeTruthy());

    const hiddenState = structuredClone(state);
    hiddenState.soccerPackage.activeOverlay = null;
    rerender(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={hiddenState} /></div>);

    expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-exiting")).toBeTruthy();
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-exiting")).toBeTruthy());
  });

  it("renders a church slide", () => {
    const state = createDefaultChurchState("Sunday");
    render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="church" state={state} /></div>);
    expect(screen.getByText(/Welcome/)).toBeInTheDocument();
  });
});
