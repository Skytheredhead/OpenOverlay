export type PresetType = "soccer" | "church" | "custom";
export type ResolutionKey = "1280x720" | "1920x1080" | "2560x1440" | "3840x2160";
export type PositionPreset =
  | "top-center"
  | "top-left"
  | "top-right"
  | "bottom-center"
  | "bottom-left"
  | "bottom-right"
  | "custom";

export type StyleVariant = "clean" | "glass" | "stripe" | "broadcast" | "neon";
export type AnimationIntensity = "subtle" | "standard" | "flashy";

export interface GlobalStyle {
  font: string;
  accentColor: string;
  backgroundMode: "transparent" | "solid" | "checker";
  backgroundColor: string;
  theme: StyleVariant;
  animation: AnimationIntensity;
}

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  preset: PositionPreset;
}

export interface OverlayElementConfig {
  id: string;
  visible: boolean;
  placement: Placement;
  variant: StyleVariant;
  accentColor?: string;
  font?: string;
}

export interface MediaRef {
  id: string;
  url: string;
  originalFilename?: string;
}

export interface RosterEntry {
  id: string;
  line: string;
  number?: string;
  name: string;
  starter: boolean;
  position?: string;
}

export interface TeamRecord {
  wins: number;
  losses: number;
  draws: number;
}

export interface SoccerTeam {
  fullName: string;
  shortName: string;
  abbreviation: string;
  logoMediaId?: string;
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  rosterText: string;
  roster: RosterEntry[];
  coach: string;
  schoolName: string;
  record: TeamRecord;
}

export interface TeamLibraryEntry extends SoccerTeam {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface SoccerClockState {
  mode: "up" | "down";
  running: boolean;
  baseSeconds: number;
  startedAtMs: number | null;
  resetSeconds: number;
  stopAtEnabled: boolean;
  stopAtSeconds: number;
  showStoppage: boolean;
  stoppageMinutes: number;
  periodLabel: string;
}

export interface SoccerStats {
  shots: { home: number; away: number };
  fouls: { home: number; away: number };
  cards: { home: number; away: number };
}

export type GraphicKind =
  | "goal"
  | "yellow-card"
  | "red-card"
  | "substitution"
  | "injury"
  | "halftime"
  | "matchup-full"
  | "matchup-lower"
  | "lineups"
  | "sponsor"
  | "lower-third"
  | "countdown"
  | "fullscreen"
  | "blank"
  | "team"
  | "both-teams"
  | "church-slide"
  | "church-lower-third";

export interface ActiveGraphic {
  id: string;
  kind: GraphicKind;
  title: string;
  subtitle?: string;
  label?: string;
  team?: "home" | "away" | "both" | "none";
  variant: StyleVariant;
  placement: Placement;
  startedAtMs: number;
  durationMs: number;
  expiresAtMs: number | null;
  payload?: Record<string, unknown>;
}

export interface SoccerState {
  gameTitle: string;
  productionName: string;
  scheduledAt: string;
  home: SoccerTeam;
  away: SoccerTeam;
  score: { home: number; away: number };
  stats: SoccerStats;
  clock: SoccerClockState;
  style: GlobalStyle;
  elements: {
    scorebug: OverlayElementConfig;
    statBug: OverlayElementConfig;
    sponsorBug: OverlayElementConfig;
    lowerThird: OverlayElementConfig;
    countdown: OverlayElementConfig;
    fullscreen: OverlayElementConfig;
  };
  activeGraphics: ActiveGraphic[];
}

export interface ChurchSlide {
  id: string;
  title: string;
  type: "text" | "image";
  text: string;
  mediaId?: string;
  mediaUrl?: string;
  section: string;
  backgroundColor: string;
  textColor: string;
  variant: StyleVariant;
}

export interface ChurchState {
  serviceTitle: string;
  sections: string[];
  slides: ChurchSlide[];
  selectedSlideId?: string;
  style: GlobalStyle;
  elements: {
    lowerThird: OverlayElementConfig;
    countdown: OverlayElementConfig;
    fullscreenSlide: OverlayElementConfig;
  };
  activeGraphics: ActiveGraphic[];
}

export interface CustomState {
  title: string;
  style: GlobalStyle;
  elements: OverlayElementConfig[];
  activeGraphics: ActiveGraphic[];
}

export type PresetState = SoccerState | ChurchState | CustomState;

export interface PresetSummary {
  id: string;
  publicId: string;
  name: string;
  type: PresetType;
  updatedAt: string;
  overlayClientCount?: number;
  state: PresetState;
}

export const RESOLUTIONS: Record<ResolutionKey, { width: number; height: number }> = {
  "1280x720": { width: 1280, height: 720 },
  "1920x1080": { width: 1920, height: 1080 },
  "2560x1440": { width: 2560, height: 1440 },
  "3840x2160": { width: 3840, height: 2160 }
};

export function makeId(prefix = "id"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function defaultGlobalStyle(): GlobalStyle {
  return {
    font: "Inter",
    accentColor: "#36d399",
    backgroundMode: "transparent",
    backgroundColor: "transparent",
    theme: "broadcast",
    animation: "standard"
  };
}

export function placementForPreset(preset: PositionPreset, width: number, height: number): Placement {
  const margin = 40;
  const centeredX = (1920 - width) / 2;
  const placements: Record<PositionPreset, Placement> = {
    "top-center": { x: centeredX, y: 42, width, height, scale: 1, preset },
    "top-left": { x: margin, y: 42, width, height, scale: 1, preset },
    "top-right": { x: 1920 - width - margin, y: 42, width, height, scale: 1, preset },
    "bottom-center": { x: centeredX, y: 1080 - height - 58, width, height, scale: 1, preset },
    "bottom-left": { x: margin, y: 1080 - height - 58, width, height, scale: 1, preset },
    "bottom-right": { x: 1920 - width - margin, y: 1080 - height - 58, width, height, scale: 1, preset },
    custom: { x: centeredX, y: 42, width, height, scale: 1, preset }
  };
  return placements[preset];
}

export function defaultElement(id: string, preset: PositionPreset, width: number, height: number, variant: StyleVariant): OverlayElementConfig {
  return {
    id,
    visible: true,
    placement: placementForPreset(preset, width, height),
    variant
  };
}

export function parseRoster(text: string): RosterEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^#?(\d{1,3})\s+(.+)$/);
      return {
        id: makeId("roster"),
        line,
        number: match?.[1],
        name: match?.[2]?.trim() || line,
        starter: false
      };
    });
}

export function defaultTeam(side: "home" | "away"): SoccerTeam {
  const rosterText =
    side === "home"
      ? "1 Avery Stone\n4 Jordan Ellis\n7 Max Grenham\n9 Luca Reyes\n11 Noah Brooks"
      : "1 Riley Park\n3 Sam Carter\n8 Eli Morgan\n10 Kai Bennett\n14 Theo Hayes";
  return {
    fullName: side === "home" ? "OpenOverlay United" : "Skyline FC",
    shortName: side === "home" ? "United" : "Skyline",
    abbreviation: side === "home" ? "OOU" : "SKY",
    primaryColor: side === "home" ? "#0f766e" : "#334155",
    secondaryColor: side === "home" ? "#99f6e4" : "#facc15",
    rosterText,
    roster: parseRoster(rosterText),
    coach: side === "home" ? "Coach Harper" : "Coach Lane",
    schoolName: side === "home" ? "OpenOverlay High" : "Skyline Prep",
    record: { wins: 0, losses: 0, draws: 0 }
  };
}

export function defaultClock(): SoccerClockState {
  return {
    mode: "up",
    running: false,
    baseSeconds: 0,
    startedAtMs: null,
    resetSeconds: 0,
    stopAtEnabled: true,
    stopAtSeconds: 45 * 60,
    showStoppage: true,
    stoppageMinutes: 0,
    periodLabel: "1st"
  };
}

export function createDefaultSoccerState(name = "Soccer"): SoccerState {
  return {
    gameTitle: name,
    productionName: "OpenOverlay Demo",
    scheduledAt: new Date().toISOString(),
    home: defaultTeam("home"),
    away: defaultTeam("away"),
    score: { home: 0, away: 0 },
    stats: {
      shots: { home: 0, away: 0 },
      fouls: { home: 0, away: 0 },
      cards: { home: 0, away: 0 }
    },
    clock: defaultClock(),
    style: defaultGlobalStyle(),
    elements: {
      scorebug: defaultElement("scorebug", "top-center", 720, 82, "broadcast"),
      statBug: defaultElement("statBug", "top-left", 330, 132, "glass"),
      sponsorBug: defaultElement("sponsorBug", "bottom-right", 260, 86, "clean"),
      lowerThird: defaultElement("lowerThird", "bottom-left", 760, 126, "stripe"),
      countdown: defaultElement("countdown", "bottom-center", 520, 126, "neon"),
      fullscreen: defaultElement("fullscreen", "custom", 1920, 1080, "broadcast")
    },
    activeGraphics: []
  };
}

export function createDefaultChurchState(name = "Church Sunday"): ChurchState {
  const titleSlide: ChurchSlide = {
    id: makeId("slide"),
    title: "Welcome",
    type: "text",
    text: "Welcome\nWe are glad you are here",
    section: "Pre-service",
    backgroundColor: "#111827",
    textColor: "#ffffff",
    variant: "glass"
  };
  return {
    serviceTitle: name,
    sections: ["Pre-service", "Worship", "Message", "Closing"],
    slides: [titleSlide],
    selectedSlideId: titleSlide.id,
    style: {
      ...defaultGlobalStyle(),
      accentColor: "#60a5fa",
      theme: "glass"
    },
    elements: {
      lowerThird: defaultElement("churchLowerThird", "bottom-left", 780, 130, "glass"),
      countdown: defaultElement("churchCountdown", "bottom-right", 430, 120, "clean"),
      fullscreenSlide: defaultElement("churchFullscreen", "custom", 1920, 1080, "glass")
    },
    activeGraphics: []
  };
}

export function createDefaultCustomState(name = "Custom"): CustomState {
  return {
    title: name,
    style: defaultGlobalStyle(),
    elements: [defaultElement("customLower", "bottom-center", 720, 120, "clean")],
    activeGraphics: []
  };
}

export function createDefaultPresetState(type: PresetType, name: string): PresetState {
  if (type === "soccer") return createDefaultSoccerState(name);
  if (type === "church") return createDefaultChurchState(name);
  return createDefaultCustomState(name);
}

export function computeClockSeconds(clock: SoccerClockState, nowMs = Date.now()): number {
  let seconds = clock.baseSeconds;
  if (clock.running && clock.startedAtMs !== null) {
    const delta = Math.max(0, Math.floor((nowMs - clock.startedAtMs) / 1000));
    seconds = clock.mode === "up" ? clock.baseSeconds + delta : clock.baseSeconds - delta;
  }
  if (clock.stopAtEnabled) {
    if (clock.mode === "up") seconds = Math.min(seconds, clock.stopAtSeconds);
    else seconds = Math.max(seconds, clock.stopAtSeconds);
  }
  return Math.max(0, seconds);
}

export function clockIsAtStop(clock: SoccerClockState, nowMs = Date.now()): boolean {
  if (!clock.stopAtEnabled) return false;
  const seconds = computeClockSeconds(clock, nowMs);
  return clock.mode === "up" ? seconds >= clock.stopAtSeconds : seconds <= clock.stopAtSeconds;
}

export function pauseClock(clock: SoccerClockState, nowMs = Date.now()): SoccerClockState {
  return {
    ...clock,
    running: false,
    baseSeconds: computeClockSeconds(clock, nowMs),
    startedAtMs: null
  };
}

export function startClock(clock: SoccerClockState, nowMs = Date.now()): SoccerClockState {
  if (clock.running) return clock;
  if (clockIsAtStop(clock, nowMs)) {
    return { ...clock, running: false };
  }
  return {
    ...clock,
    running: true,
    startedAtMs: nowMs
  };
}

export function resetClock(clock: SoccerClockState): SoccerClockState {
  return {
    ...clock,
    running: false,
    baseSeconds: clock.resetSeconds,
    startedAtMs: null
  };
}

export function setClockSeconds(clock: SoccerClockState, seconds: number): SoccerClockState {
  return {
    ...clock,
    running: false,
    baseSeconds: Math.max(0, Math.floor(seconds)),
    resetSeconds: Math.max(0, Math.floor(seconds)),
    startedAtMs: null
  };
}

export function parseClockTime(input: string): number {
  const parts = input.trim().split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part) || part < 0)) return 0;
  if (parts.length === 1) return parts[0];
  const [minutes, seconds] = parts;
  return minutes * 60 + Math.min(seconds, 59);
}

export function formatClock(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(clamped / 60);
  const remainder = clamped % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function formatSoccerClock(clock: SoccerClockState, nowMs = Date.now()): string {
  const base = formatClock(computeClockSeconds(clock, nowMs));
  if (clock.showStoppage && clock.stoppageMinutes > 0) {
    return `${base} +${clock.stoppageMinutes}`;
  }
  return base;
}

export function withoutExpiredGraphics<T extends { activeGraphics: ActiveGraphic[] }>(state: T, nowMs = Date.now()): T {
  return {
    ...state,
    activeGraphics: state.activeGraphics.filter((graphic) => graphic.expiresAtMs === null || graphic.expiresAtMs > nowMs)
  };
}
