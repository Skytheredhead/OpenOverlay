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
        {type !== "soccer" ? state.activeGraphics
          .filter((graphic) => graphic.expiresAtMs === null || graphic.expiresAtMs > now)
          .map((graphic) => (
          <TemporaryGraphic key={graphic.id} graphic={graphic} />
        )) : null}
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
  const soccer = state.soccerPackage;
  const activeOverlay = soccer.activeOverlay;
  const countdownSeconds = packageCountdownSeconds(soccer.countdown, now);
  const timerRunning = soccer.countdown.running && countdownSeconds > 0;
  const activeClass = activeOverlay ? `show-${activeOverlay}` : "show-none";

  return (
    <Positioned element={state.elements.fullscreen} interactive={interactive} onDragStart={onDragStart}>
      <div
        className={[
          "lab-stage",
          `package-${soccer.overlayPackage}`,
          `surface-${soccer.surface}`,
          activeClass,
          timerRunning ? "timer-running" : "",
          countdownSeconds >= 3600 ? "countdown-has-hours" : "",
          soccer.lowerResultState === "FINAL" ? "result-final" : "",
          soccer.packageBackground ? "" : "background-off"
        ].filter(Boolean).join(" ")}
        style={{
          "--package-bg-opacity": soccer.packageBackgroundOpacity,
          "--scorebug-width": `${soccer.scorebugWidth}%`
        } as React.CSSProperties}
      >
        {activeOverlay === "full-matchup" ? <FullMatchup state={state} countdownSeconds={countdownSeconds} /> : null}
        {activeOverlay === "lower-matchup" ? <LowerMatchup state={state} countdownSeconds={countdownSeconds} /> : null}
        {activeOverlay === "lower-result" ? <LowerResult state={state} countdownSeconds={countdownSeconds} /> : null}
        {activeOverlay === "lineup-panel" ? <LineupPanel state={state} /> : null}
        {activeOverlay === "scorebug" ? <LabScorebug state={state} now={now} /> : null}
        {activeOverlay === "countdown-timer" ? <CountdownOverlay state={state} countdownSeconds={countdownSeconds} /> : null}
        {activeOverlay === "one-line-text" ? <OneLineText state={state} /> : null}
        {activeOverlay === "two-line-text" ? <TwoLineText state={state} /> : null}
      </div>
    </Positioned>
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

function FullMatchup({ state, countdownSeconds }: { state: SoccerState; countdownSeconds: number }) {
  return (
    <article key="full-matchup" className="lab-overlay overlay-full-matchup overlay-entering" aria-label="Full page matchup">
      <PackageBackground enabled={state.soccerPackage.packageBackground} />
      <div className="match-kicker">{state.gameTitle}</div>
      <div className="full-teams">
        <FullTeam team={state.home} side="home" />
        <div className="full-divider"><b>{formatPackageTime(countdownSeconds)}</b></div>
        <FullTeam team={state.away} side="away" />
      </div>
      <div className="match-footer">{state.productionName}</div>
    </article>
  );
}

function FullTeam({ team, side }: { team: SoccerState["home"]; side: "home" | "away" }) {
  return (
    <section className={`full-team ${side}`}>
      {side === "home" ? <TeamImage team={team} className="lab-team-logo" /> : null}
      <div className="team-copy">
        <b>{team.fullName}</b>
        <small>{formatRecord(team.record)}</small>
      </div>
      {side === "away" ? <TeamImage team={team} className="lab-team-logo" /> : null}
    </section>
  );
}

function LowerMatchup({ state, countdownSeconds }: { state: SoccerState; countdownSeconds: number }) {
  return (
    <article key="lower-matchup" className="lab-overlay overlay-lower-matchup overlay-entering" aria-label="Lower matchup">
      <div className="lower-shell">
        <div className="lower-kicker">{state.gameTitle}</div>
        <div className="lower-match-row">
          <LowerTeam team={state.home} side="home" />
          <div className="lower-match-center">
            <strong>VS</strong>
            <span><em>Countdown</em><b>{formatPackageTime(countdownSeconds)}</b></span>
          </div>
          <LowerTeam team={state.away} side="away" />
        </div>
      </div>
    </article>
  );
}

function LowerTeam({ team, side }: { team: SoccerState["home"]; side: "home" | "away" }) {
  return (
    <section className={`lower-team ${side}`}>
      {side === "home" ? <TeamImage team={team} className="lab-team-logo small" /> : null}
      <div><b>{team.fullName}</b><span>{formatRecord(team.record)}</span></div>
      {side === "away" ? <TeamImage team={team} className="lab-team-logo small" /> : null}
    </section>
  );
}

function LowerResult({ state, countdownSeconds }: { state: SoccerState; countdownSeconds: number }) {
  return (
    <article key="lower-result" className="lab-overlay overlay-lower-result overlay-entering" aria-label="Lower matchup with score">
      <div className="lower-shell">
        <div className="lower-kicker">{state.gameTitle}</div>
        <div className="lower-result-row">
          <section className="lower-result-team lower-result-home">
            <TeamImage team={state.home} className="lab-team-logo small" />
            <b>{state.home.abbreviation}</b>
          </section>
          <strong className="lower-result-score">{state.score.home}</strong>
          <div className="lower-result-state"><span>{state.soccerPackage.lowerResultState}</span><b>{formatPackageTime(countdownSeconds)}</b></div>
          <strong className="lower-result-score">{state.score.away}</strong>
          <section className="lower-result-team lower-result-away">
            <b>{state.away.abbreviation}</b>
            <TeamImage team={state.away} className="lab-team-logo small" />
          </section>
        </div>
      </div>
    </article>
  );
}

function LineupPanel({ state }: { state: SoccerState }) {
  const team = state.soccerPackage.lineupTeam === "away" ? state.away : state.home;
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(team.roster.length / pageSize));
  const page = Math.min(totalPages - 1, Math.max(0, state.soccerPackage.lineupPage));
  const rows = team.roster.slice(page * pageSize, page * pageSize + pageSize);
  while (rows.length < pageSize) rows.push({ id: `blank-${rows.length}`, line: "", name: "", starter: false });
  return (
    <article key="lineup-panel" className="lab-overlay overlay-lineup overlay-entering" aria-label="Lineup panel">
      <div className="lineup-head">
        <span>{team.fullName}</span>
        <TeamImage team={team} className="lab-team-logo small" />
      </div>
      <ol className="lineup-list">
        {rows.map((player) => <li key={player.id}><b>{player.number || ""}</b><span>{player.name}</span></li>)}
      </ol>
      <small className="lineup-page">{page + 1} / {totalPages}</small>
    </article>
  );
}

function LabScorebug({ state, now }: { state: SoccerState; now: number }) {
  const vertical = state.soccerPackage.scorebugLayout === "vertical";
  return (
    <article
      key={`scorebug-${state.soccerPackage.scorebugLayout}`}
      className={`lab-overlay overlay-scorebug ${vertical ? "scorebug-vertical" : "scorebug-horizontal"} overlay-entering`}
      aria-label="Scorebug"
    >
      <div className="bug-team"><TeamImage team={state.home} className="bug-logo" /><span>{state.home.abbreviation}</span></div>
      <div className="bug-score">{state.score.home}</div>
      <div className="bug-clock"><strong>{formatSoccerClock(state.clock, now)}</strong><em>·</em><span>{state.clock.periodLabel}</span></div>
      <div className="bug-score">{state.score.away}</div>
      <div className="bug-team"><span>{state.away.abbreviation}</span><TeamImage team={state.away} className="bug-logo" /></div>
    </article>
  );
}

function CountdownOverlay({ state, countdownSeconds }: { state: SoccerState; countdownSeconds: number }) {
  const small = state.soccerPackage.countdown.mode === "small";
  return (
    <article
      key={`countdown-${state.soccerPackage.countdown.mode}-${state.soccerPackage.countdown.position}`}
      className={`lab-overlay overlay-countdown ${small ? `countdown-small position-${state.soccerPackage.countdown.position}` : "countdown-full"} overlay-entering`}
      aria-label="Countdown timer"
    >
      <PackageBackground enabled={!small && state.soccerPackage.packageBackground} />
      <div className="timer-card"><span>Kickoff Countdown</span><strong className="timer-value">{formatPackageTime(countdownSeconds)}</strong></div>
    </article>
  );
}

function OneLineText({ state }: { state: SoccerState }) {
  return (
    <article key="one-line-text" className={`lab-overlay overlay-text-bug one-line-text position-${state.soccerPackage.oneLinePosition} overlay-entering`} aria-label="One line text bug">
      <div>{state.soccerPackage.oneLineText}</div>
    </article>
  );
}

function TwoLineText({ state }: { state: SoccerState }) {
  return (
    <article key="two-line-text" className={`lab-overlay overlay-text-bug two-line-text position-${state.soccerPackage.twoLinePosition} overlay-entering`} aria-label="Two line text bug">
      <div><strong>{state.soccerPackage.twoLineTextA}</strong><span>{state.soccerPackage.twoLineTextB}</span></div>
    </article>
  );
}

function PackageBackground({ enabled }: { enabled: boolean }) {
  return enabled ? <div className="package-bg" aria-hidden="true" /> : null;
}

function TeamImage({ team, className }: { team: SoccerState["home"]; className: string }) {
  const crop = team.imageCrop || { x: 0, y: 0, zoom: 1 };
  return (
    <div className={className} style={{ "--team-primary": team.primaryColor, "--team-secondary": team.secondaryColor } as React.CSSProperties}>
      {team.logoUrl ? (
        <img
          src={mediaApi.mediaUrl(team.logoUrl)}
          alt=""
          style={{
            transform: `translate(${crop.x}px, ${crop.y}px) scale(${crop.zoom})`
          }}
        />
      ) : (
        <span>{(team.abbreviation || team.shortName || "?").slice(0, 2)}</span>
      )}
    </div>
  );
}

function packageCountdownSeconds(countdown: SoccerState["soccerPackage"]["countdown"], now: number): number {
  if (!countdown.running || countdown.startedAtMs === null) return countdown.seconds;
  const elapsed = Math.max(0, Math.floor((now - countdown.startedAtMs) / 1000));
  return Math.max(0, countdown.seconds - elapsed);
}

function formatPackageTime(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const remainder = clamped % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

function formatRecord(record: SoccerState["home"]["record"]): string {
  return `${record.wins}-${record.losses}-${record.draws}`;
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
