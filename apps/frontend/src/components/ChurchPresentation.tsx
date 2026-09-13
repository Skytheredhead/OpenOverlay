import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { churchOnAirSlide, orderedChurchSlides, formatClock, type ChurchBackgroundPreset, type ChurchSlide, type ChurchState } from "@openoverlay/shared";
import { mediaApi } from "../lib/api";

export const churchBackgroundOptions: { id: ChurchBackgroundPreset; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "aurora", label: "Aurora" },
  { id: "dusk", label: "Dusk" },
  { id: "ocean", label: "Ocean" },
  { id: "geometry", label: "Geometry" },
  { id: "rings", label: "Soft arcs" },
  { id: "stars", label: "Starlight" }
];

export function ChurchBackdrop({ preset, motion = true }: { preset: ChurchBackgroundPreset; motion?: boolean }) {
  return (
    <div className={`church-backdrop backdrop-${preset} ${motion ? "has-motion" : "is-still"}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

export function ChurchBackgroundPicker({
  value,
  motion,
  onChange,
  onMotionChange
}: {
  value: ChurchBackgroundPreset;
  motion: boolean;
  onChange: (preset: ChurchBackgroundPreset) => void;
  onMotionChange: (motion: boolean) => void;
}) {
  return (
    <fieldset className="church-background-picker">
      <legend>Worship background</legend>
      <div className="church-background-options">
        {churchBackgroundOptions.map((preset) => (
          <button
            type="button"
            key={preset.id}
            aria-label={`${preset.label} background`}
            aria-pressed={value === preset.id}
            onClick={() => onChange(preset.id)}
          >
            <span className="church-background-swatch">
              <ChurchBackdrop preset={preset.id} motion={false} />
            </span>
            <span>{preset.label}</span>
          </button>
        ))}
      </div>
      {value !== "solid" ? (
        <div className="church-background-motion" role="group" aria-label="Background motion">
          <span>Motion</span>
          <button className="button" type="button" aria-pressed={motion} onClick={() => onMotionChange(true)}>
            Slow
          </button>
          <button className="button" type="button" aria-pressed={!motion} onClick={() => onMotionChange(false)}>
            Still
          </button>
          <small>Reduced-motion settings use a still background.</small>
        </div>
      ) : null}
    </fieldset>
  );
}

export function ChurchSlideContent({
  slide,
  hideText = false,
  font = "Arial",
  motion = true
}: {
  slide: ChurchSlide;
  hideText?: boolean;
  font?: string;
  motion?: boolean;
}) {
  const requestedSize = slide.fontSize ?? 86;
  const charsPerLine = Math.max(15, Math.floor(1640 / (requestedSize * 0.56)));
  const lines = slide.text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  const size = Math.min(requestedSize, 790 / (Math.max(1, lines) * 1.2));
  return (
    <div className="church-content" style={{ background: slide.backgroundColor, color: slide.textColor, fontFamily: `${font}, Arial, sans-serif` }}>
      {!slide.mediaUrl && slide.backgroundPreset && slide.backgroundPreset !== "solid" ? (
        <ChurchBackdrop preset={slide.backgroundPreset} motion={motion && slide.backgroundMotion !== false} />
      ) : null}
      {slide.mediaUrl ? <img src={mediaApi.mediaUrl(slide.mediaUrl)} alt="" /> : null}
      {(slide.mediaUrl || (slide.backgroundPreset && slide.backgroundPreset !== "solid")) && (slide.backgroundDim ?? 0) > 0 ? (
        <div className="church-content-shade" style={{ opacity: (slide.backgroundDim ?? 0) / 100 }} />
      ) : null}
      {!hideText ? (
        <>
          <div className="church-content-body" style={{ fontSize: `${size / 19.2}cqw`, textAlign: slide.textAlign ?? "center" }}>
            {slide.text}
          </div>
          {slide.reference ? <div className="church-content-reference">{slide.reference}</div> : null}
        </>
      ) : null}
    </div>
  );
}

export function ChurchStageScreen({ state, serverTimeMs, connected = true }: { state: ChurchState; serverTimeMs?: number; connected?: boolean }) {
  const anchor = useMemo(() => ({ server: serverTimeMs ?? Date.now(), received: performance.now() }), [serverTimeMs]);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const now = anchor.server + Math.max(0, performance.now() - anchor.received);
  const live = churchOnAirSlide(state);
  const ordered = orderedChurchSlides(state);
  const index = live ? ordered.findIndex((slide) => slide.id === live.id) : -1;
  const next = ordered[index + 1];
  const countdown = [...state.activeGraphics]
    .reverse()
    .find((graphic) => graphic.kind === "countdown" && graphic.expiresAtMs !== null && graphic.expiresAtMs > now);
  return (
    <div className="church-stage-screen">
      <header>
        <strong>{state.serviceTitle}</strong>
        <span>
          {!connected
            ? "Connection lost · holding last state"
            : state.blackout
              ? "Audience screen black"
              : !state.elements.fullscreenSlide.visible
                ? "Audience slide hidden"
                : state.textCleared
                  ? "Audience text cleared"
                  : "Live"}
        </span>
        <time>{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      </header>
      <div className="church-stage-slides">
        <section aria-label="Current slide">
          <h2>Current · {live?.label || live?.title || "No slide"}</h2>
          <div className="church-stage-copy" style={{ fontSize: `clamp(20px, ${Math.min(4.2, 110 / Math.max(25, (live?.text.length ?? 0) / 8))}vw, 90px)` }}>
            {live?.text || "Ready for service"}
          </div>
          {live?.reference ? <p>{live.reference}</p> : null}
          {live?.notes ? <aside className="church-stage-notes">{live.notes}</aside> : null}
        </section>
        <section aria-label="Next slide">
          <h2>Next · {next?.label || next?.title || "End of service"}</h2>
          <div className="church-stage-next">{next?.text || ""}</div>
          {next?.reference ? <p>{next.reference}</p> : null}
        </section>
      </div>
      <footer>
        {state.stageMessage ? <strong className="church-stage-message">{state.stageMessage}</strong> : <span />}
        {countdown ? (
          <strong className="church-stage-timer">
            {countdown.title} {formatClock(Math.ceil((countdown.expiresAtMs! - now) / 1000))}
          </strong>
        ) : null}
      </footer>
    </div>
  );
}

export function ChurchDisplay({ children, mode }: { children: ReactNode; mode: "projector" | "stage" }) {
  const [error, setError] = useState("");
  const [toolsVisible, setToolsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function revealTools() {
    setToolsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setToolsVisible(false), 2000);
  }
  useEffect(() => {
    revealTools();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      setError("");
    } catch {
      setError("Use your browser’s fullscreen command to fill this screen.");
    }
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "f" && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        void fullscreen();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <main
      aria-label={mode === "stage" ? "Stage screen" : "Projector output"}
      className={`church-display church-display-${mode} ${toolsVisible ? "show-display-tools" : ""}`}
      onPointerMove={revealTools}
      onDoubleClick={() => void fullscreen()}
    >
      {children}
      <div className="church-display-tools">
        <button type="button" onClick={() => void fullscreen()}>
          Fullscreen · F
        </button>
        {error ? <span role="status">{error}</span> : null}
      </div>
    </main>
  );
}
