import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDefaultChurchState, createDefaultSoccerState } from "@openoverlay/shared";
import { OverlayRenderer } from "./OverlayRenderer";

describe("OverlayRenderer", () => {
  it("renders a soccer scorebug and stats bug", () => {
    const state = createDefaultSoccerState("Test Match");
    state.score.home = 3;
    state.score.away = 2;
    render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="soccer" state={state} /></div>);
    expect(screen.getByText("OOU")).toBeInTheDocument();
    expect(screen.getByText("SKY")).toBeInTheDocument();
    expect(screen.getByText("Shots")).toBeInTheDocument();
  });

  it("renders a church slide", () => {
    const state = createDefaultChurchState("Sunday");
    render(<div style={{ width: 960, height: 540 }}><OverlayRenderer type="church" state={state} /></div>);
    expect(screen.getByText(/Welcome/)).toBeInTheDocument();
  });
});
