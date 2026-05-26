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

  it("applies soccer package color bank variables to the stage", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.overlayPackage = "rounded";
    state.soccerPackage.colorBanks.rounded.maroon = "#123456";
    state.soccerPackage.colorBanks.rounded.gold = "#fedcba";
    const { container } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);

    await waitFor(() => expect(frameBody(container)?.querySelector("#stage")).toBeTruthy());
    const stage = frameBody(container)?.querySelector<HTMLElement>("#stage");
    expect(stage?.style.getPropertyValue("--maroon")).toBe("#123456");
    expect(stage?.style.getPropertyValue("--gold")).toBe("#fedcba");
  });

  it("only marks requested soccer text fields as updated", async () => {
    const state = createDefaultSoccerState("Test Match");
    const { container, rerender } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    await waitFor(() => expect(frameBody(container)?.querySelector("[data-bind-event-title]")).toBeTruthy());
    expect(frameBody(container)?.querySelector("[data-bind-event-title]")?.classList.contains("text-updated")).toBe(false);

    const nextState = structuredClone(state);
    nextState.gameTitle = "Updated Match";
    nextState.soccerPackage.textAnimation = { id: 1, fields: ["event-title"] };
    rerender(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={nextState} /></div>);

    await waitFor(() => expect(frameBody(container)?.querySelector("[data-bind-event-title]")?.classList.contains("text-updated")).toBe(true));
    expect(frameBody(container)?.querySelector("[data-bind-production]")?.classList.contains("text-updated")).toBe(false);
  });

  it("marks only requested soccer team logos as updated", async () => {
    const state = createDefaultSoccerState("Test Match");
    const { container, rerender } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    await waitFor(() => expect(frameBody(container)?.querySelector(".full-team.home [data-bind-team-logo]")).toBeTruthy());

    const nextState = structuredClone(state);
    nextState.home.logoUrl = "/media/home-updated.png";
    nextState.soccerPackage.textAnimation = { id: 2, fields: ["home-logo"] };
    rerender(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={nextState} /></div>);

    await waitFor(() => expect(frameBody(container)?.querySelector(".full-team.home [data-bind-team-logo]")?.classList.contains("text-updated")).toBe(true));
    expect(frameBody(container)?.querySelector(".full-team.away [data-bind-team-logo]")?.classList.contains("text-updated")).toBe(false);
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

  it("keeps incoming and outgoing soccer overlays in separate layers", async () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.activeOverlay = "full-matchup";
    const { container, rerender } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    await waitFor(() => expect(frameBody(container)?.querySelector(".overlay-full-matchup.overlay-entering")).toBeTruthy());

    const nextState = structuredClone(state);
    nextState.soccerPackage.activeOverlay = "scorebug";
    nextState.soccerPackage.selectedOverlay = "scorebug";
    rerender(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={nextState} /></div>);

    const body = frameBody(container);
    expect(body?.querySelector(".overlay-layer-exiting .overlay-full-matchup.overlay-exiting")).toBeTruthy();
    expect(body?.querySelector(".overlay-layer-active .overlay-scorebug.overlay-entering")).toBeTruthy();
  });

  it("renders a church slide", () => {
    const state = createDefaultChurchState("Sunday");
    render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="church" state={state} /></div>);
    expect(screen.getByText(/Welcome/)).toBeInTheDocument();
  });
});
