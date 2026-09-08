import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultChurchState, defaultTeam, type ChurchState } from "@openoverlay/shared";
import { ChurchControls, MediaLibrary, TeamFields } from "./App";
import { OverlayRenderer } from "./components/OverlayRenderer";
import { mediaApi } from "./lib/api";

afterEach(() => vi.restoreAllMocks());

describe("UI regressions", () => {
  it("keeps an on-air church slide unchanged while adding and editing a draft", () => {
    function Editor() {
      const [state, setState] = useState(createDefaultChurchState("Sunday"));
      return (
        <>
          <ChurchControls
            state={state}
            tab="slides"
            media={[]}
            commitState={(next) => setState(next as ChurchState)}
            runAction={vi.fn(async () => undefined)}
          />
          <div data-testid="output">
            <OverlayRenderer type="church" state={state} />
          </div>
        </>
      );
    }
    render(<Editor />);
    const output = screen.getByTestId("output");
    expect(output).toHaveTextContent("We are glad you are here");
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(output).toHaveTextContent("We are glad you are here");
    fireEvent.change(screen.getByLabelText("Text", { selector: "textarea" }), { target: { value: "Next song" } });
    expect(output).not.toHaveTextContent("Next song");
    fireEvent.click(screen.getByRole("button", { name: "Show slide" }));
    expect(output).toHaveTextContent("Next song");
  });

  it("allows incomplete record text until the operator commits it", () => {
    const onChange = vi.fn();
    render(<TeamFields team={defaultTeam("home")} media={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Record (W-L-T)");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12-3-" } });
    expect(input).toHaveValue("12-3-");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "12-3-1" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ record: { wins: 12, losses: 3, draws: 1 } });
  });

  it("resets an invalid record draft when selecting another team", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TeamFields team={defaultTeam("home")} media={[]} onChange={onChange} />);
    const input = screen.getByLabelText("Record (W-L-T)");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12-3-" } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    const away = { ...defaultTeam("away"), record: { wins: 3, losses: 2, draws: 1 } };
    rerender(<TeamFields team={away} media={[]} onChange={onChange} />);
    expect(screen.getByLabelText("Record (W-L-T)")).toHaveValue("3-2-1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears a media load failure after a successful retry", async () => {
    vi.spyOn(mediaApi, "list").mockRejectedValueOnce(new Error("Media unavailable")).mockResolvedValue({ media: [], nextCursor: null });
    render(<MediaLibrary />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry media" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
