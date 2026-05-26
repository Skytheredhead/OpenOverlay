import {
  type ActiveGraphic,
  type ChurchState,
  type GraphicKind,
  type Placement,
  type PresetState,
  type SoccerState,
  clockIsAtStop,
  createDefaultPresetState,
  defaultElement,
  makeId,
  normalizeSoccerState,
  parseRoster,
  pauseClock,
  resetClock,
  startClock,
  withoutExpiredGraphics
} from "@openoverlay/shared";

export type PresetAction =
  | "home-score-plus"
  | "home-score-minus"
  | "away-score-plus"
  | "away-score-minus"
  | "clock-toggle"
  | "clock-reset"
  | "trigger-goal"
  | "trigger-yellow-card"
  | "trigger-red-card"
  | "trigger-substitution"
  | "trigger-halftime"
  | "trigger-full-time"
  | "trigger-lineups"
  | "trigger-sponsor"
  | "trigger-lower-third"
  | "trigger-countdown"
  | "show-overlay"
  | "hide-overlay"
  | "select-overlay"
  | "countdown-toggle"
  | "countdown-start"
  | "countdown-stop"
  | "countdown-reset"
  | "lineup-next"
  | "lineup-prev"
  | "clear";

export function isSoccerState(state: PresetState): state is SoccerState {
  return "home" in state && "away" in state && "clock" in state && "score" in state;
}

export function isChurchState(state: PresetState): state is ChurchState {
  return "slides" in state && "serviceTitle" in state;
}

export function materializeState(state: PresetState, nowMs = Date.now()): PresetState {
  let pruned = withoutExpiredGraphics(state as PresetState & { activeGraphics: ActiveGraphic[] }, nowMs);
  if (isSoccerState(pruned)) {
    pruned = normalizeSoccerState(pruned);
    if (pruned.clock.running && clockIsAtStop(pruned.clock, nowMs)) {
      pruned = {
        ...pruned,
        clock: pauseClock(pruned.clock, nowMs)
      };
    }
    const countdown = pruned.soccerPackage.countdown;
    if (countdown.running && countdown.startedAtMs !== null) {
      const elapsed = Math.max(0, Math.floor((nowMs - countdown.startedAtMs) / 1000));
      if (countdown.seconds - elapsed <= 0) {
        pruned = {
          ...pruned,
          soccerPackage: {
            ...pruned.soccerPackage,
            countdown: {
              ...countdown,
              seconds: 0,
              running: false,
              startedAtMs: null
            }
          }
        };
      }
    }
  }
  return pruned;
}

export function mergePresetState(existing: PresetState, patch: Partial<PresetState>): PresetState {
  const next = deepMerge(existing, patch) as PresetState;
  if (isSoccerState(next)) {
    next.home.roster = parseRoster(next.home.rosterText);
    next.away.roster = parseRoster(next.away.rosterText);
    return normalizeSoccerState(next);
  }
  return next;
}

export function applyAction(state: PresetState, action: PresetAction, payload: Record<string, unknown> = {}, nowMs = Date.now()): PresetState {
  const current = materializeState(state, nowMs);
  if (action === "clear") return clearTemporaryGraphics(current);

  if (isSoccerState(current)) {
    return applySoccerAction(current, action, payload, nowMs);
  }

  if (isChurchState(current) && action === "trigger-countdown") {
    return {
      ...current,
      activeGraphics: toggleGraphic(current.activeGraphics, makeGraphic("countdown", "Countdown", "", current.elements.countdown.placement, payload, nowMs))
    };
  }

  return current;
}

export function cloneStateForShare(state: PresetState): PresetState {
  return JSON.parse(JSON.stringify(state)) as PresetState;
}

export function ensurePresetState(type: "soccer" | "church" | "custom", name: string, state?: PresetState): PresetState {
  const ensured = state || createDefaultPresetState(type, name);
  return isSoccerState(ensured) ? normalizeSoccerState(ensured) : ensured;
}

function applySoccerAction(state: SoccerState, action: PresetAction, payload: Record<string, unknown>, nowMs: number): SoccerState {
  const current = normalizeSoccerState(state);
  const next: SoccerState = { ...current, score: { ...current.score }, clock: { ...current.clock }, soccerPackage: structuredClone(current.soccerPackage) };

  if (action === "home-score-plus") next.score.home += 1;
  if (action === "home-score-minus") next.score.home = Math.max(0, next.score.home - 1);
  if (action === "away-score-plus") next.score.away += 1;
  if (action === "away-score-minus") next.score.away = Math.max(0, next.score.away - 1);
  if (action === "home-score-plus" || action === "home-score-minus") next.soccerPackage.textAnimation = { id: nowMs, fields: ["home-score"] };
  if (action === "away-score-plus" || action === "away-score-minus") next.soccerPackage.textAnimation = { id: nowMs, fields: ["away-score"] };

  if (action === "clock-toggle") {
    next.clock = next.clock.running ? pauseClock(next.clock, nowMs) : startClock(next.clock, nowMs);
    if (next.clock.running) {
      next.soccerPackage.activeOverlay = "scorebug";
      next.soccerPackage.selectedOverlay = "scorebug";
    }
  }

  if (action === "clock-reset") {
    next.clock = resetClock(next.clock);
  }

  if (action === "show-overlay" || action === "select-overlay") {
    const overlay = typeof payload.overlay === "string" ? payload.overlay : undefined;
    if (isLabOverlay(overlay)) {
      next.soccerPackage = { ...next.soccerPackage, activeOverlay: overlay, selectedOverlay: overlay };
    }
  }

  if (action === "hide-overlay") {
    const overlay = typeof payload.overlay === "string" ? payload.overlay : undefined;
    next.soccerPackage = {
      ...next.soccerPackage,
      activeOverlay: overlay && next.soccerPackage.activeOverlay !== overlay ? next.soccerPackage.activeOverlay : null,
      selectedOverlay: isLabOverlay(overlay) ? overlay : next.soccerPackage.selectedOverlay
    };
  }

  if (action === "countdown-toggle" || action === "countdown-start") {
    next.soccerPackage = { ...next.soccerPackage, activeOverlay: "countdown-timer", selectedOverlay: "countdown-timer" };
    next.soccerPackage.countdown = startPackageCountdown(next.soccerPackage.countdown, nowMs);
  }

  if (action === "countdown-toggle" && state.soccerPackage?.countdown?.running) {
    next.soccerPackage.countdown = stopPackageCountdown(next.soccerPackage.countdown, nowMs);
  }

  if (action === "countdown-stop") {
    next.soccerPackage.countdown = stopPackageCountdown(next.soccerPackage.countdown, nowMs);
  }

  if (action === "countdown-reset") {
    next.soccerPackage.countdown = {
      ...next.soccerPackage.countdown,
      seconds: next.soccerPackage.countdown.resetSeconds,
      running: false,
      startedAtMs: null
    };
  }

  if (action === "lineup-next" || action === "lineup-prev") {
    const team = next.soccerPackage.lineupTeam === "away" ? next.away : next.home;
    const totalPages = Math.max(1, Math.ceil(team.roster.length / 6));
    const step = action === "lineup-next" ? 1 : -1;
    next.soccerPackage.lineupPage = (next.soccerPackage.lineupPage + step + totalPages) % totalPages;
    next.soccerPackage.activeOverlay = "lineup-panel";
    next.soccerPackage.selectedOverlay = "lineup-panel";
  }

  if (action === "trigger-countdown") {
    next.soccerPackage = { ...next.soccerPackage, activeOverlay: "countdown-timer", selectedOverlay: "countdown-timer" };
    next.soccerPackage.countdown = startPackageCountdown(next.soccerPackage.countdown, nowMs);
  }

  return next;
}

function isLabOverlay(value: unknown): value is SoccerState["soccerPackage"]["selectedOverlay"] {
  return typeof value === "string" && [
    "full-matchup",
    "lower-matchup",
    "lower-result",
    "lineup-panel",
    "scorebug",
    "countdown-timer",
    "one-line-text",
    "two-line-text"
  ].includes(value);
}

function startPackageCountdown(countdown: SoccerState["soccerPackage"]["countdown"], nowMs: number): SoccerState["soccerPackage"]["countdown"] {
  if (countdown.running) return countdown;
  return {
    ...countdown,
    seconds: countdown.seconds <= 0 ? countdown.resetSeconds : countdown.seconds,
    running: true,
    startedAtMs: nowMs
  };
}

function stopPackageCountdown(countdown: SoccerState["soccerPackage"]["countdown"], nowMs: number): SoccerState["soccerPackage"]["countdown"] {
  if (!countdown.running || countdown.startedAtMs === null) return { ...countdown, running: false, startedAtMs: null };
  const elapsed = Math.max(0, Math.floor((nowMs - countdown.startedAtMs) / 1000));
  return {
    ...countdown,
    seconds: Math.max(0, countdown.seconds - elapsed),
    running: false,
    startedAtMs: null
  };
}

function toggleGraphic(activeGraphics: ActiveGraphic[], graphic: ActiveGraphic): ActiveGraphic[] {
  const activeIndex = activeGraphics.findIndex((candidate) => candidate.kind === graphic.kind);
  if (activeIndex >= 0) {
    return activeGraphics.filter((_, index) => index !== activeIndex);
  }
  return [...activeGraphics, graphic];
}

function clearTemporaryGraphics<T extends PresetState>(state: T): T {
  if (isSoccerState(state)) {
    return {
      ...state,
      soccerPackage: {
        ...normalizeSoccerState(state).soccerPackage,
        activeOverlay: null,
        countdown: { ...normalizeSoccerState(state).soccerPackage.countdown, running: false, startedAtMs: null }
      },
      activeGraphics: []
    };
  }
  return {
    ...state,
    activeGraphics: []
  };
}

function makeGraphic(
  kind: GraphicKind,
  title: string,
  subtitle: string,
  placement: Placement,
  payload: Record<string, unknown>,
  nowMs: number
): ActiveGraphic {
  const durationSeconds = typeof payload.durationSeconds === "number" ? payload.durationSeconds : 5;
  const durationMs = Math.max(1, durationSeconds) * 1000;
  return {
    id: makeId("graphic"),
    kind,
    title,
    subtitle,
    label: typeof payload.label === "string" ? payload.label : undefined,
    team: payload.team === "home" || payload.team === "away" || payload.team === "both" || payload.team === "none" ? payload.team : undefined,
    variant: payload.variant === "clean" || payload.variant === "glass" || payload.variant === "stripe" || payload.variant === "broadcast" || payload.variant === "neon" ? payload.variant : "broadcast",
    placement,
    startedAtMs: nowMs,
    durationMs,
    expiresAtMs: payload.durationSeconds === 0 ? null : nowMs + durationMs,
    payload
  };
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(source)) return source ?? target;
  const output: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    output[key] = isPlainObject(value) && isPlainObject(output[key]) ? deepMerge(output[key], value) : value;
  }
  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function blankElement() {
  return defaultElement("blank", "bottom-center", 720, 120, "clean");
}
