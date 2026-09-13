import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { CachedPages } from "./CachedPages";

function TestPage({ name, start, stop }: { name: string; start: (name: string) => void; stop: (name: string) => void }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    start(name);
    return () => stop(name);
  }, [name, start, stop]);
  return <input aria-label={name} value={value} onChange={(event) => setValue(event.target.value)} />;
}

function Harness({ start, stop }: { start: (name: string) => void; stop: (name: string) => void }) {
  const navigate = useNavigate();
  const [session, setSession] = useState(0);
  return (
    <>
      {Array.from({ length: 10 }, (_, index) => (
        <button key={index} onClick={() => navigate(`/page-${index}`)}>{`Page ${index}`}</button>
      ))}
      <button onClick={() => setSession((current) => current + 1)}>New session</button>
      <CachedPages key={session}>{(location) => <TestPage name={location.pathname} start={start} stop={stop} />}</CachedPages>
    </>
  );
}

describe("visited page cache", () => {
  it("mounts on demand, pauses hidden effects, and restores state with one visible page", () => {
    const start = vi.fn();
    const stop = vi.fn();
    render(
      <MemoryRouter initialEntries={["/page-0"]}>
        <Harness start={start} stop={stop} />
      </MemoryRouter>
    );
    expect(start.mock.calls).toEqual([["/page-0"]]);
    fireEvent.change(screen.getByLabelText("/page-0"), { target: { value: "Saved view" } });
    fireEvent.click(screen.getByRole("button", { name: "Page 1" }));
    expect(stop).toHaveBeenCalledWith("/page-0");
    expect(screen.queryByLabelText("/page-0")).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Page 0" }));
    expect(screen.getByLabelText("/page-0")).toHaveValue("Saved view");
    expect(start.mock.calls).toEqual([["/page-0"], ["/page-1"], ["/page-0"]]);
    expect(stop).toHaveBeenCalledWith("/page-1");
  });

  it("bounds retained pages and clears state when the signed-in session changes", () => {
    render(
      <MemoryRouter initialEntries={["/page-0"]}>
        <Harness start={() => undefined} stop={() => undefined} />
      </MemoryRouter>
    );
    fireEvent.change(screen.getByLabelText("/page-0"), { target: { value: "Old account" } });
    for (let index = 1; index <= 9; index++) fireEvent.click(screen.getByRole("button", { name: `Page ${index}` }));
    fireEvent.click(screen.getByRole("button", { name: "Page 0" }));
    expect(screen.getByLabelText("/page-0")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("/page-0"), { target: { value: "Current account" } });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(screen.getByLabelText("/page-0")).toHaveValue("");
  });
});
