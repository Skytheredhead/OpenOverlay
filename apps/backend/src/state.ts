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
  | "trigger-countdown"
  | "clear";

export function isSoccerState(state: PresetState): state is SoccerState {
  return "home" in state && "away" in state && "clock" in state && "score" in state;
}

export function isChurchState(state: PresetState): state is ChurchState {
  return "slides" in state && "serviceTitle" in state;
}

export function materializeState(state: PresetState, nowMs = Date.now()): PresetState {
  const pruned = withoutExpiredGraphics(state as PresetState & { activeGraphics: ActiveGraphic[] }, nowMs);
  if (isSoccerState(pruned) && pruned.clock.running && clockIsAtStop(pruned.clock, nowMs)) {
    return {
      ...pruned,
      clock: pauseClock(pruned.clock, nowMs)
    };
  }
  return pruned;
}

export function mergePresetState(existing: PresetState, patch: Partial<PresetState>): PresetState {
  const next = deepMerge(existing, patch) as PresetState;
  if (isSoccerState(next)) {
    next.home.roster = parseRoster(next.home.rosterText);
    next.away.roster = parseRoster(next.away.rosterText);
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
  return state || createDefaultPresetState(type, name);
}

function applySoccerAction(state: SoccerState, action: PresetAction, payload: Record<string, unknown>, nowMs: number): SoccerState {
  const next: SoccerState = { ...state, score: { ...state.score }, clock: { ...state.clock } };

  if (action === "home-score-plus") next.score.home += 1;
  if (action === "home-score-minus") next.score.home = Math.max(0, next.score.home - 1);
  if (action === "away-score-plus") next.score.away += 1;
  if (action === "away-score-minus") next.score.away = Math.max(0, next.score.away - 1);

  if (action === "clock-toggle") {
    next.clock = next.clock.running ? pauseClock(next.clock, nowMs) : startClock(next.clock, nowMs);
  }

  if (action === "clock-reset") {
    next.clock = resetClock(next.clock);
  }

  const lowerPlacement = next.elements.lowerThird.placement;
  const fullscreenPlacement = next.elements.fullscreen.placement;

  if (action === "trigger-goal") {
    const team = typeof payload.team === "string" ? payload.team : "home";
    const teamName = team === "away" ? next.away.shortName : next.home.shortName;
    const title = textPayload(payload.title, "GOAL");
    const subtitle = textPayload(payload.subtitle, teamName);
    return withToggledGraphic(next, makeGraphic("goal", title, subtitle, fullscreenPlacement, { ...payload, team }, nowMs));
  }

  if (action === "trigger-yellow-card") {
    return withToggledGraphic(next, makeGraphic("yellow-card", textPayload(payload.title, "Yellow Card"), textPayload(payload.subtitle, ""), lowerPlacement, payload, nowMs));
  }

  if (action === "trigger-red-card") {
    return withToggledGraphic(next, makeGraphic("red-card", textPayload(payload.title, "Red Card"), textPayload(payload.subtitle, ""), lowerPlacement, payload, nowMs));
  }

  if (action === "trigger-substitution") {
    return withToggledGraphic(next, makeGraphic("substitution", textPayload(payload.title, "Substitution"), textPayload(payload.subtitle, ""), lowerPlacement, payload, nowMs));
  }

  if (action === "trigger-halftime") {
    return withToggledGraphic(next, makeGraphic("halftime", textPayload(payload.title, "Halftime"), `${next.home.shortName} ${next.score.home} - ${next.score.away} ${next.away.shortName}`, fullscreenPlacement, payload, nowMs));
  }

  if (action === "trigger-countdown") {
    return withToggledGraphic(next, makeGraphic("countdown", textPayload(payload.title, "Countdown"), textPayload(payload.subtitle, "Next segment"), next.elements.countdown.placement, payload, nowMs));
  }

  return next;
}

function withToggledGraphic(state: SoccerState, graphic: ActiveGraphic): SoccerState {
  return {
    ...state,
    activeGraphics: toggleGraphic(state.activeGraphics, graphic)
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

function textPayload(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
