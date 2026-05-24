import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  formatSoccerClock,
  type ActiveGraphic,
  type ChurchState,
  type OverlayElementConfig,
  type Placement,
  type PresetState,
  type PresetType,
  type SoccerState
} from "@openoverlay/shared";
import { mediaApi } from "../lib/api";

interface OverlayRendererProps {
  type: PresetType;
  state: PresetState;
  transparent?: boolean;
  safeArea?: boolean;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

export function OverlayRenderer({ type, state, transparent = true, safeArea = false, interactive = false, onDragStart }: OverlayRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: BASE_WIDTH, height: BASE_HEIGHT });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const resize = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    resize.observe(node);
    return () => resize.disconnect();
  }, []);

  const scale = Math.min(size.width / BASE_WIDTH, size.height / BASE_HEIGHT);
  const x = (size.width - BASE_WIDTH * scale) / 2;
  const y = (size.height - BASE_HEIGHT * scale) / 2;
  const theme = "style" in state ? state.style.theme : "broadcast";

  return (
    <div ref={containerRef} className={`overlay-viewport ${transparent ? "is-transparent" : "has-fill"} theme-${theme}`}>
      <div
        className="overlay-stage"
        style={{
          width: BASE_WIDTH,
          height: BASE_HEIGHT,
          transform: `translate(${x}px, ${y}px) scale(${scale})`
        }}
      >
        {safeArea ? <div className="safe-area" /> : null}
        {type === "soccer" && isSoccerState(state) ? (
          <SoccerOverlay state={state} now={now} interactive={interactive} onDragStart={onDragStart} />
        ) : null}
        {type === "church" && isChurchState(state) ? (
          <ChurchOverlay state={state} now={now} interactive={interactive} onDragStart={onDragStart} />
        ) : null}
        {state.activeGraphics
          .filter((graphic) => graphic.expiresAtMs === null || graphic.expiresAtMs > now)
          .map((graphic) => (
          <TemporaryGraphic key={graphic.id} graphic={graphic} />
        ))}
      </div>
    </div>
  );
}

function SoccerOverlay({
  state,
  now,
  interactive,
  onDragStart
}: {
  state: SoccerState;
  now: number;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}) {
  const scorebug = state.elements.scorebug;
  const statBug = state.elements.statBug;
  return (
    <>
      {scorebug.visible ? (
        <Positioned element={scorebug} interactive={interactive} onDragStart={onDragStart}>
          <div className={`scorebug variant-${scorebug.variant}`}>
            <TeamBlock team={state.home} score={state.score.home} side="home" />
            <div className="scorebug-center">
              <div className="period">{state.clock.periodLabel}</div>
              <div className="clock">{formatSoccerClock(state.clock, now)}</div>
            </div>
            <TeamBlock team={state.away} score={state.score.away} side="away" />
          </div>
        </Positioned>
      ) : null}

      {statBug.visible ? (
        <Positioned element={statBug} interactive={interactive} onDragStart={onDragStart}>
          <div className={`statbug variant-${statBug.variant}`}>
            <StatLine label="Shots" home={state.stats.shots.home} away={state.stats.shots.away} />
            <StatLine label="Fouls" home={state.stats.fouls.home} away={state.stats.fouls.away} />
            <StatLine label="Cards" home={state.stats.cards.home} away={state.stats.cards.away} />
          </div>
        </Positioned>
      ) : null}
    </>
  );
}

function ChurchOverlay({
  state,
  now,
  interactive,
  onDragStart
}: {
  state: ChurchState;
  now: number;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}) {
  const slide = state.slides.find((item) => item.id === state.selectedSlideId) || state.slides[0];
  return (
    <>
      {slide && state.elements.fullscreenSlide.visible ? (
        <Positioned element={state.elements.fullscreenSlide} interactive={interactive} onDragStart={onDragStart}>
          <div className={`church-slide variant-${slide.variant}`} style={{ background: slide.backgroundColor, color: slide.textColor }}>
            {slide.mediaUrl ? <img src={mediaApi.mediaUrl(slide.mediaUrl)} alt="" /> : null}
            <div className="church-slide-text">{slide.text}</div>
          </div>
        </Positioned>
      ) : null}
      {state.elements.countdown.visible ? (
        <Positioned element={state.elements.countdown} interactive={interactive} onDragStart={onDragStart}>
          <div className={`countdown-element variant-${state.elements.countdown.variant}`}>
            <span>Countdown</span>
            <strong>{new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong>
          </div>
        </Positioned>
      ) : null}
    </>
  );
}

function Positioned({
  element,
  children,
  interactive,
  onDragStart
}: {
  element: OverlayElementConfig;
  children: React.ReactNode;
  interactive?: boolean;
  onDragStart?: (elementId: string, event: PointerEvent<HTMLElement>) => void;
}) {
  return (
    <section
      className={`overlay-element ${interactive ? "is-interactive" : ""}`}
      data-element-id={element.id}
      style={placementStyle(element.placement)}
      onPointerDown={(event) => {
        if (interactive) onDragStart?.(element.id, event);
      }}
    >
      {children}
    </section>
  );
}

function TeamBlock({ team, score, side }: { team: SoccerState["home"]; score: number; side: "home" | "away" }) {
  return (
    <div className={`team-block ${side}`} style={{ "--team-primary": team.primaryColor, "--team-secondary": team.secondaryColor } as React.CSSProperties}>
      {team.logoUrl ? <img className="team-logo" src={mediaApi.mediaUrl(team.logoUrl)} alt="" /> : <div className="team-logo fallback">{team.abbreviation.slice(0, 2)}</div>}
      <span className="team-name">{team.abbreviation || team.shortName}</span>
      <strong className="team-score" key={score}>
        {score}
      </strong>
    </div>
  );
}

function StatLine({ label, home, away }: { label: string; home: number; away: number }) {
  return (
    <div className="stat-line">
      <span>{label}</span>
      <strong>{home}</strong>
      <em>{away}</em>
    </div>
  );
}

function TemporaryGraphic({ graphic }: { graphic: ActiveGraphic }) {
  const className = `temporary-graphic graphic-${graphic.kind} variant-${graphic.variant}`;
  const showLineups = graphic.kind === "lineups";
  return (
    <section className={className} style={placementStyle(graphic.placement)}>
      <div className="graphic-label">{graphic.label || graphic.kind.replace("-", " ")}</div>
      <h2>{graphic.title}</h2>
      {graphic.subtitle ? <p>{graphic.subtitle}</p> : null}
      {showLineups ? <small>Starting XI</small> : null}
    </section>
  );
}

function placementStyle(placement: Placement): React.CSSProperties {
  return {
    left: placement.x,
    top: placement.y,
    width: placement.width,
    height: placement.height,
    transform: `scale(${placement.scale})`,
    transformOrigin: "top left"
  };
}

function isSoccerState(state: PresetState): state is SoccerState {
  return "score" in state && "clock" in state;
}

function isChurchState(state: PresetState): state is ChurchState {
  return "slides" in state;
}

export function getElementById(state: PresetState, elementId: string): OverlayElementConfig | undefined {
  if ("elements" in state && !Array.isArray(state.elements)) {
    return Object.values(state.elements as Record<string, OverlayElementConfig>).find((element) => element.id === elementId);
  }
  if ("elements" in state && Array.isArray(state.elements)) {
    return (state.elements as OverlayElementConfig[]).find((element) => element.id === elementId);
  }
  return undefined;
}

export function updateElementPlacement(state: PresetState, elementId: string, placement: Placement): PresetState {
  const copy = structuredClone(state) as PresetState;
  if ("elements" in copy && !Array.isArray(copy.elements)) {
    for (const element of Object.values(copy.elements as Record<string, OverlayElementConfig>)) {
      if (element.id === elementId) element.placement = placement;
    }
  }
  if ("elements" in copy && Array.isArray(copy.elements)) {
    for (const element of copy.elements as OverlayElementConfig[]) {
      if (element.id === elementId) element.placement = placement;
    }
  }
  return copy;
}
