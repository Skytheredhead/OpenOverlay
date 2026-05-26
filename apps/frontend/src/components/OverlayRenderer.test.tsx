import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDefaultChurchState, createDefaultSoccerState } from "@openoverlay/shared";
import { OverlayRenderer } from "./OverlayRenderer";

describe("OverlayRenderer", () => {
  it("renders the Classic soccer matchup package", () => {
    const state = createDefaultSoccerState("Test Match");
    state.score.home = 3;
    state.score.away = 2;
    render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    expect(screen.getByText("Test Match")).toBeInTheDocument();
    expect(screen.getByText("OpenOverlay United")).toBeInTheDocument();
    expect(screen.getByText("Skyline FC")).toBeInTheDocument();
    expect(screen.getByText("05:00")).toBeInTheDocument();
  });

  it("renders the Rounded scorebug package with team image slots", () => {
    const state = createDefaultSoccerState("Test Match");
    state.soccerPackage.overlayPackage = "rounded";
    state.soccerPackage.activeOverlay = "scorebug";
    state.home.logoUrl = "/home.png";
    state.home.imageCrop = { x: 4, y: -3, zoom: 1.2 };
    const { container } = render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    expect(screen.getByText("OOU")).toBeInTheDocument();
    const image = container.querySelector(".bug-logo img");
    expect(image).toHaveAttribute("src", "http://localhost:8734/home.png");
  });

  it("renders a church slide", () => {
    const state = createDefaultChurchState("Sunday");
    render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="church" state={state} /></div>);
    expect(screen.getByText(/Welcome/)).toBeInTheDocument();
  });
});
