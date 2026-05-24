import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import {
  Copy,
  Film,
  Image,
  LayoutDashboard,
  LogOut,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings,
  ShieldAlert,
  Trash2,
  Undo2,
  Upload,
  Users,
  X
} from "lucide-react";
import {
  computeClockSeconds,
  createDefaultChurchState,
  createDefaultSoccerState,
  formatClock,
  parseClockTime,
  placementForPreset,
  setClockSeconds,
  type ChurchState,
  type ChurchSlide,
  type OverlayElementConfig,
  type PositionPreset,
  type PresetState,
  type PresetSummary,
  type PresetType,
  type SoccerState,
  type StyleVariant
} from "@openoverlay/shared";
import { getElementById, OverlayRenderer, updateElementPlacement } from "./components/OverlayRenderer";
import { API_BASE, WS_URL, authApi, mediaApi, overlayApi, presetApi, type MediaItem, type User } from "./lib/api";
import { useDebouncedCallback, useLocalStorage } from "./lib/hooks";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login mode="login" />} />
        <Route path="/signup" element={<Login mode="signup" />} />
        <Route path="/overlay/:overlayId" element={<OverlayPage test={false} />} />
        <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
        <Route path="/dash" element={<RequireAuth><AppShell><Dashboard /></AppShell></RequireAuth>} />
        <Route path="/dash/media" element={<RequireAuth><AppShell><MediaLibrary /></AppShell></RequireAuth>} />
        <Route path="/dash/presets/:presetId" element={<RequireAuth><AppShell><PresetEditor /></AppShell></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await authApi.me();
      setUser(response.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("Auth context missing");
  return ctx;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-page">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Home() {
  return (
    <div className="site-shell marketing">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">OO</span>
          <span>OpenOverlay</span>
        </Link>
        <div className="nav-actions">
          <Link className="button ghost" to="/login">Login</Link>
          <Link className="button primary" to="/dash">Open dashboard</Link>
        </div>
      </header>
      <main className="hero">
        <section>
          <h1>OpenOverlay</h1>
          <p>Livestream graphics for soccer, church services, and production teams that need one OBS browser source, durable state, and fast show controls.</p>
          <div className="hero-actions">
            <Link className="button primary" to="/signup">Create account</Link>
            <Link className="button" to="/login">Login</Link>
          </div>
        </section>
        <section className="hero-preview" aria-label="Overlay preview">
          <OverlayRenderer type="soccer" state={demoSoccerState()} transparent={false} />
        </section>
      </main>
    </div>
  );
}

function Login({ mode }: { mode: "login" | "signup" }) {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (mode === "signup") await authApi.signup(email, password);
      else await authApi.login(email, password);
      await refresh();
      navigate("/dash");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    }
  }

  return (
    <div className="site-shell auth-page">
      <form className="auth-panel" onSubmit={submit}>
        <Link to="/" className="brand">
          <span className="brand-mark">OO</span>
          <span>OpenOverlay</span>
        </Link>
        <h1>{mode === "signup" ? "Create account" : "Login"}</h1>
        <div className="form-grid">
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required />
          </label>
          <button className="button primary" type="submit">{mode === "signup" ? "Sign up" : "Login"}</button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <p className="muted" style={{ marginTop: 16 }}>
          {mode === "signup" ? "Already have an account? " : "Need an account? "}
          <Link to={mode === "signup" ? "/login" : "/signup"}>{mode === "signup" ? "Login" : "Sign up"}</Link>
        </p>
      </form>
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/dash" className="brand">
          <span className="brand-mark">OO</span>
          <span>OpenOverlay</span>
        </Link>
        <nav>
          <NavLink to="/dash" end><LayoutDashboard size={18} /> Presets</NavLink>
          <NavLink to="/dash/media"><Image size={18} /> Media</NavLink>
          <button onClick={() => void logout()}><LogOut size={18} /> Logout</button>
        </nav>
        <p className="muted" style={{ marginTop: 24, fontSize: 13 }}>{user?.email}</p>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function Dashboard() {
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [type, setType] = useState<PresetType>("soccer");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const response = await presetApi.list();
    setPresets(response.presets);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  async function createPreset() {
    const name = window.prompt("Preset name", type === "soccer" ? "Soccer" : type === "church" ? "Church Sunday" : "Custom");
    if (!name) return;
    const response = await presetApi.create(name, type);
    navigate(`/dash/presets/${response.preset.id}`);
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Presets</h1>
          <p className="muted">Tabs for games, services, productions, and one-off overlay packages.</p>
        </div>
        <div className="control-row">
          <select className="number-input" value={type} onChange={(event) => setType(event.target.value as PresetType)}>
            <option value="soccer">Soccer</option>
            <option value="church">Church</option>
            <option value="custom">Custom</option>
          </select>
          <button className="button primary" onClick={() => void createPreset()}><Plus size={17} /> New preset</button>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <section className="preset-grid">
        {presets.map((preset) => (
          <article className="preset-card" key={preset.id}>
            <h2>{preset.name}</h2>
            <p>{preset.type} preset</p>
            <p className="muted">Overlay clients: {preset.overlayClientCount || 0}</p>
            <div className="control-row">
              <Link className="button primary" to={`/dash/presets/${preset.id}`}>Edit</Link>
              <Link className="button" to={`/overlay-test/${preset.publicId}`} target="_blank">Test</Link>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

function PresetEditor() {
  const { presetId } = useParams();
  const [preset, setPreset] = useState<PresetSummary | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [tab, setTab] = useState("control");
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [history, setHistory] = useState<PresetState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const selectedElement = useMemo(() => {
    if (!preset) return undefined;
    if (isSoccerState(preset.state)) return preset.state.elements.scorebug;
    if (isChurchState(preset.state)) return preset.state.elements.lowerThird;
    return undefined;
  }, [preset]);

  const load = useCallback(async () => {
    if (!presetId) return;
    const [presetResponse, mediaResponse] = await Promise.all([presetApi.get(presetId), mediaApi.list()]);
    setPreset(presetResponse.preset);
    setHistory([presetResponse.preset.state]);
    setHistoryIndex(0);
    setMedia(mediaResponse.media);
  }, [presetId]);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  useEffect(() => {
    if (!presetId) return;
    const socket = io(WS_URL, {
      withCredentials: true,
      transports: ["websocket", "polling"],
      auth: { role: "admin", presetId },
      query: { role: "admin", presetId }
    });
    socketRef.current = socket;
    socket.on("connect", () => setConnection("connected"));
    socket.on("disconnect", () => setConnection("disconnected"));
    socket.on("connect_error", () => setConnection("disconnected"));
    socket.on("preset:update", (payload: PresetSummary) => {
      setPreset(payload);
    });
    socket.on("overlay:clients", (payload: { count: number }) => {
      setPreset((current) => (current ? { ...current, overlayClientCount: payload.count } : current));
    });
    return () => {
      socket.disconnect();
    };
  }, [presetId]);

  const debouncedPersist = useDebouncedCallback((nextState: PresetState) => {
    if (!presetId) return;
    void presetApi.patch(presetId, { state: nextState }).then((response) => setPreset(response.preset)).catch((err) => setError(err.message));
  }, 180);

  const commitState = useCallback((nextState: PresetState, persist = true) => {
    setPreset((current) => (current ? { ...current, state: nextState } : current));
    setHistory((current) => {
      const trimmed = current.slice(0, historyIndex + 1);
      return [...trimmed, structuredClone(nextState)].slice(-60);
    });
    setHistoryIndex((index) => Math.min(index + 1, 59));
    if (persist) debouncedPersist(nextState);
  }, [debouncedPersist, historyIndex]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z" || !preset) return;
      event.preventDefault();
      const nextIndex = event.shiftKey ? Math.min(history.length - 1, historyIndex + 1) : Math.max(0, historyIndex - 1);
      const nextState = history[nextIndex];
      if (!nextState || nextIndex === historyIndex) return;
      setHistoryIndex(nextIndex);
      setPreset({ ...preset, state: structuredClone(nextState) });
      void presetApi.patch(preset.id, { state: nextState });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [history, historyIndex, preset]);

  async function runAction(action: string, payload: Record<string, unknown> = {}) {
    if (!preset) return;
    const response = await presetApi.action(preset.id, action, payload);
    setPreset(response.preset);
  }

  async function duplicatePreset() {
    if (!preset) return;
    const response = await presetApi.duplicate(preset.id);
    window.location.href = `/dash/presets/${response.preset.id}`;
  }

  async function sharePreset() {
    if (!preset) return;
    const email = window.prompt("Recipient email");
    if (!email) return;
    await presetApi.share(preset.id, email);
    window.alert("Preset duplicated into recipient account.");
  }

  async function rotateActionKey() {
    if (!preset) return;
    const response = await presetApi.actionKey(preset.id);
    setActionKey(response.actionKey);
  }

  function handleDragStart(elementId: string, event: PointerEvent<HTMLElement>) {
    if (!preset || !frameRef.current) return;
    const element = getElementById(preset.state, elementId);
    if (!element) return;
    const baseState = preset.state;
    const start = { x: event.clientX, y: event.clientY, placement: { ...element.placement } };
    const rect = frameRef.current.getBoundingClientRect();
    const scale = Math.min(rect.width / 1920, rect.height / 1080);

    function onMove(moveEvent: globalThis.PointerEvent) {
      const dx = (moveEvent.clientX - start.x) / scale;
      const dy = (moveEvent.clientY - start.y) / scale;
      const nextPlacement = { ...start.placement, x: Math.round(start.placement.x + dx), y: Math.round(start.placement.y + dy), preset: "custom" as PositionPreset };
      commitState(updateElementPlacement(baseState, elementId, nextPlacement));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  if (!preset) return <div>Loading preset...</div>;
  const overlayUrl = `${window.location.origin}/overlay/${preset.publicId}`;

  return (
    <>
      <div className="page-title">
        <div>
          <h1>{preset.name}</h1>
          <p className="muted">{preset.type} preset · OBS URL: {overlayUrl}</p>
        </div>
        <div className="status-row">
          <span className={`status-pill ${connection === "connected" ? "ok" : "warn"}`}>{connection}</span>
          <span className="status-pill ok">{preset.overlayClientCount || 0} overlay clients</span>
          <Link className="button" to={`/overlay-test/${preset.publicId}`} target="_blank"><MonitorPlay size={17} /> Test</Link>
          <button className="button" onClick={() => void duplicatePreset()}><Copy size={17} /> Duplicate</button>
          <button className="button" onClick={() => void sharePreset()}><Users size={17} /> Share</button>
        </div>
      </div>

      {connection !== "connected" ? <div className="error">Backend or overlay WebSocket is disconnected. The overlay will keep showing its last known state.</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <div className="editor-layout">
        <section className="preview-column">
          <div className="preview-frame" ref={frameRef}>
            <OverlayRenderer type={preset.type} state={preset.state} safeArea interactive onDragStart={handleDragStart} />
          </div>
          <div className="panel">
            <div className="control-row">
              <button className="button danger" onClick={() => void runAction("clear")}><ShieldAlert size={17} /> Panic clear</button>
              <button className="button" onClick={() => setHistoryIndex(Math.max(0, historyIndex - 1))}><Undo2 size={17} /> Undo</button>
              <button className="button" onClick={() => void presetApi.patch(preset.id, { state: preset.state })}><Save size={17} /> Save</button>
              <button className="button" onClick={() => void rotateActionKey()}><Settings size={17} /> Action key</button>
            </div>
            {actionKey ? (
              <p className="muted" style={{ marginTop: 10 }}>
                Action key created. Store it somewhere secure; it will not be shown again. Example: POST {API_BASE}/api/presets/{preset.id}/actions/home-score-plus with x-openoverlay-action-key.
              </p>
            ) : null}
          </div>
        </section>

        <aside className="inspector">
          <div className="tabs">
            {["control", "teams", "graphics", "style", "church"].map((item) => (
              <button key={item} className={`tab ${tab === item ? "active" : ""}`} onClick={() => setTab(item)}>{item}</button>
            ))}
          </div>
          {preset.type === "soccer" && isSoccerState(preset.state) ? (
            <SoccerControls state={preset.state} media={media} tab={tab} commitState={commitState} runAction={runAction} />
          ) : null}
          {preset.type === "church" && isChurchState(preset.state) ? (
            <ChurchControls state={preset.state} media={media} tab={tab} commitState={commitState} />
          ) : null}
          {selectedElement ? <ElementInspector state={preset.state} element={selectedElement} commitState={commitState} /> : null}
        </aside>
      </div>
    </>
  );
}

function SoccerControls({
  state,
  media,
  tab,
  commitState,
  runAction
}: {
  state: SoccerState;
  media: MediaItem[];
  tab: string;
  commitState: (state: PresetState) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const clockValue = formatClock(computeClockSeconds(state.clock));

  function update(patch: Partial<SoccerState>) {
    commitState({ ...state, ...patch });
  }

  function updateClock(patch: Partial<SoccerState["clock"]>) {
    update({ clock: { ...state.clock, ...patch } });
  }

  function updateTeam(side: "home" | "away", patch: Partial<SoccerState["home"]>) {
    update({ [side]: { ...state[side], ...patch } } as Partial<SoccerState>);
  }

  if (tab === "teams") {
    return (
      <>
        <TeamPanel title="Home team" side="home" team={state.home} media={media} onChange={(patch) => updateTeam("home", patch)} />
        <TeamPanel title="Away team" side="away" team={state.away} media={media} onChange={(patch) => updateTeam("away", patch)} />
      </>
    );
  }

  if (tab === "graphics") {
    return (
      <div className="panel">
        <h2>Temporary graphics</h2>
        <div className="form-grid">
          <GraphicButton label="Goal" action="trigger-goal" runAction={runAction} />
          <GraphicButton label="Yellow card" action="trigger-yellow-card" runAction={runAction} />
          <GraphicButton label="Red card" action="trigger-red-card" runAction={runAction} />
          <GraphicButton label="Substitution" action="trigger-substitution" runAction={runAction} />
          <GraphicButton label="Halftime" action="trigger-halftime" runAction={runAction} />
          <GraphicButton label="Countdown" action="trigger-countdown" runAction={runAction} />
        </div>
      </div>
    );
  }

  if (tab === "style") {
    return <StylePanel state={state} commitState={commitState} />;
  }

  return (
    <>
      <div className="panel">
        <h2>Score</h2>
        <div className="two-col">
          <ScoreControls label={state.home.abbreviation} plus={() => runAction("home-score-plus")} minus={() => runAction("home-score-minus")} />
          <ScoreControls label={state.away.abbreviation} plus={() => runAction("away-score-plus")} minus={() => runAction("away-score-minus")} />
        </div>
      </div>
      <div className="panel">
        <h2>Clock</h2>
        <div className="control-row">
          <button className="button primary" onClick={() => runAction("clock-toggle")}>{state.clock.running ? <Pause size={17} /> : <Play size={17} />} {state.clock.running ? "Pause" : "Start"}</button>
          <button className="button" onClick={() => runAction("clock-reset")}><RotateCcw size={17} /> Reset</button>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Manual time</span>
            <input defaultValue={clockValue} onBlur={(event) => updateClock(setClockSeconds(state.clock, parseClockTime(event.target.value)))} />
          </label>
          <div className="two-col">
            <label className="field">
              <span>Mode</span>
              <select value={state.clock.mode} onChange={(event) => updateClock({ mode: event.target.value as "up" | "down" })}>
                <option value="up">Count up</option>
                <option value="down">Count down</option>
              </select>
            </label>
            <label className="field">
              <span>Period</span>
              <input value={state.clock.periodLabel} onChange={(event) => updateClock({ periodLabel: event.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Stop at</span>
            <input defaultValue={formatClock(state.clock.stopAtSeconds)} onBlur={(event) => updateClock({ stopAtSeconds: parseClockTime(event.target.value) })} />
          </label>
          <label className="control-row">
            <input type="checkbox" checked={state.clock.stopAtEnabled} onChange={(event) => updateClock({ stopAtEnabled: event.target.checked })} />
            Stop at enabled
          </label>
          <label className="control-row">
            <input type="checkbox" checked={state.clock.showStoppage} onChange={(event) => updateClock({ showStoppage: event.target.checked })} />
            Show stoppage time
          </label>
        </div>
      </div>
    </>
  );
}

function ScoreControls({ label, plus, minus }: { label: string; plus: () => void; minus: () => void }) {
  return (
    <div className="panel">
      <h3>{label}</h3>
      <div className="control-row">
        <button className="button primary" onClick={plus}><Plus size={17} /> 1</button>
        <button className="button" onClick={minus}>-1</button>
      </div>
    </div>
  );
}

function TeamPanel({
  title,
  side,
  team,
  media,
  onChange
}: {
  title: string;
  side: "home" | "away";
  team: SoccerState["home"];
  media: MediaItem[];
  onChange: (patch: Partial<SoccerState["home"]>) => void;
}) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <div className="form-grid">
        <div className="two-col">
          <label className="field"><span>Full name</span><input value={team.fullName} onChange={(e) => onChange({ fullName: e.target.value })} /></label>
          <label className="field"><span>Short name</span><input value={team.shortName} onChange={(e) => onChange({ shortName: e.target.value })} /></label>
        </div>
        <div className="two-col">
          <label className="field"><span>Abbreviation</span><input value={team.abbreviation} onChange={(e) => onChange({ abbreviation: e.target.value.toUpperCase().slice(0, 5) })} /></label>
          <label className="field"><span>Coach</span><input value={team.coach} onChange={(e) => onChange({ coach: e.target.value })} /></label>
        </div>
        <div className="two-col">
          <label className="field"><span>Primary</span><input type="color" value={team.primaryColor} onChange={(e) => onChange({ primaryColor: e.target.value })} /></label>
          <label className="field"><span>Secondary</span><input type="color" value={team.secondaryColor} onChange={(e) => onChange({ secondaryColor: e.target.value })} /></label>
        </div>
        <label className="field">
          <span>Logo</span>
          <select
            value={team.logoMediaId || ""}
            onChange={(event) => {
              const selected = media.find((item) => item.id === event.target.value);
              onChange({ logoMediaId: selected?.id, logoUrl: selected?.url });
            }}
          >
            <option value="">No logo</option>
            {media.map((item) => <option key={item.id} value={item.id}>{item.originalFilename}</option>)}
          </select>
        </label>
        <label className="field"><span>School</span><input value={team.schoolName} onChange={(e) => onChange({ schoolName: e.target.value })} /></label>
        <label className="field">
          <span>Roster</span>
          <textarea value={team.rosterText} onChange={(e) => onChange({ rosterText: e.target.value })} placeholder="10 Max Grenham" />
        </label>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>{side === "home" ? "Home" : "Away"} roster lines are parsed into lineup entries automatically.</p>
    </div>
  );
}

function GraphicButton({ label, action, runAction }: { label: string; action: string; runAction: (action: string, payload?: Record<string, unknown>) => Promise<void> }) {
  return (
    <button
      className="button"
      onClick={() => {
        const title = window.prompt(`${label} text`, label);
        void runAction(action, { title: title || label, durationSeconds: 5 });
      }}
    >
      <Film size={17} /> {label}
    </button>
  );
}

function StylePanel({ state, commitState }: { state: SoccerState | ChurchState; commitState: (state: PresetState) => void }) {
  const variants: StyleVariant[] = ["clean", "glass", "stripe", "broadcast", "neon"];
  return (
    <div className="panel">
      <h2>Global style</h2>
      <div className="form-grid">
        <label className="field"><span>Font</span><input value={state.style.font} onChange={(e) => commitState({ ...state, style: { ...state.style, font: e.target.value } })} /></label>
        <label className="field"><span>Accent</span><input type="color" value={state.style.accentColor} onChange={(e) => commitState({ ...state, style: { ...state.style, accentColor: e.target.value } })} /></label>
        <label className="field">
          <span>Theme</span>
          <select value={state.style.theme} onChange={(e) => commitState({ ...state, style: { ...state.style, theme: e.target.value as StyleVariant } })}>
            {variants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Animation</span>
          <select value={state.style.animation} onChange={(e) => commitState({ ...state, style: { ...state.style, animation: e.target.value as SoccerState["style"]["animation"] } })}>
            <option value="subtle">subtle</option>
            <option value="standard">standard</option>
            <option value="flashy">flashy</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function ChurchControls({
  state,
  media,
  tab,
  commitState
}: {
  state: ChurchState;
  media: MediaItem[];
  tab: string;
  commitState: (state: PresetState) => void;
}) {
  const selected = state.slides.find((slide) => slide.id === state.selectedSlideId) || state.slides[0];

  function updateSlide(slide: ChurchSlide) {
    commitState({ ...state, slides: state.slides.map((item) => (item.id === slide.id ? slide : item)), selectedSlideId: slide.id });
  }

  function addSlide(type: "text" | "image") {
    const slide: ChurchSlide = {
      id: `slide_${Date.now()}`,
      title: type === "text" ? "Text slide" : "Image slide",
      type,
      text: type === "text" ? "New slide" : "",
      section: state.sections[0] || "Service",
      backgroundColor: "#111827",
      textColor: "#ffffff",
      variant: "glass"
    };
    commitState({ ...state, slides: [...state.slides, slide], selectedSlideId: slide.id });
  }

  if (tab === "style") return <StylePanel state={state} commitState={commitState} />;

  return (
    <div className="panel">
      <h2>Slides</h2>
      <div className="control-row">
        <button className="button" onClick={() => addSlide("text")}><Plus size={17} /> Text</button>
        <button className="button" onClick={() => addSlide("image")}><Image size={17} /> Image</button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Selected slide</span>
          <select value={selected?.id || ""} onChange={(e) => commitState({ ...state, selectedSlideId: e.target.value })}>
            {state.slides.map((slide) => <option key={slide.id} value={slide.id}>{slide.title}</option>)}
          </select>
        </label>
        {selected ? (
          <>
            <label className="field"><span>Title</span><input value={selected.title} onChange={(e) => updateSlide({ ...selected, title: e.target.value })} /></label>
            <label className="field"><span>Text</span><textarea value={selected.text} onChange={(e) => updateSlide({ ...selected, text: e.target.value })} /></label>
            <label className="field">
              <span>Image/background</span>
              <select value={selected.mediaId || ""} onChange={(e) => {
                const item = media.find((candidate) => candidate.id === e.target.value);
                updateSlide({ ...selected, mediaId: item?.id, mediaUrl: item?.url, type: item ? "image" : selected.type });
              }}>
                <option value="">None</option>
                {media.map((item) => <option key={item.id} value={item.id}>{item.originalFilename}</option>)}
              </select>
            </label>
            <div className="two-col">
              <label className="field"><span>Background</span><input type="color" value={selected.backgroundColor} onChange={(e) => updateSlide({ ...selected, backgroundColor: e.target.value })} /></label>
              <label className="field"><span>Text color</span><input type="color" value={selected.textColor} onChange={(e) => updateSlide({ ...selected, textColor: e.target.value })} /></label>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ElementInspector({ state, element, commitState }: { state: PresetState; element: OverlayElementConfig; commitState: (state: PresetState) => void }) {
  function updateElement(patch: Partial<OverlayElementConfig>) {
    const copy = structuredClone(state) as PresetState;
    const candidate = getElementById(copy, element.id);
    if (candidate) Object.assign(candidate, patch);
    commitState(copy);
  }

  function updatePlacement(patch: Partial<OverlayElementConfig["placement"]>) {
    updateElement({ placement: { ...element.placement, ...patch } });
  }

  return (
    <div className="panel">
      <h2>Selected element</h2>
      <div className="form-grid">
        <label className="control-row">
          <input type="checkbox" checked={element.visible} onChange={(e) => updateElement({ visible: e.target.checked })} />
          Visible
        </label>
        <label className="field">
          <span>Position preset</span>
          <select value={element.placement.preset} onChange={(e) => updatePlacement(placementForPreset(e.target.value as PositionPreset, element.placement.width, element.placement.height))}>
            {["top-center", "top-left", "top-right", "bottom-center", "bottom-left", "bottom-right", "custom"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div className="two-col">
          <NumberField label="X" value={element.placement.x} onChange={(value) => updatePlacement({ x: value, preset: "custom" })} />
          <NumberField label="Y" value={element.placement.y} onChange={(value) => updatePlacement({ y: value, preset: "custom" })} />
          <NumberField label="Width" value={element.placement.width} onChange={(value) => updatePlacement({ width: value })} />
          <NumberField label="Height" value={element.placement.height} onChange={(value) => updatePlacement({ height: value })} />
        </div>
        <label className="field">
          <span>Scale</span>
          <input type="number" step="0.05" value={element.placement.scale} onChange={(e) => updatePlacement({ scale: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Variant</span>
          <select value={element.variant} onChange={(e) => updateElement({ variant: e.target.value as StyleVariant })}>
            {["clean", "glass", "stripe", "broadcast", "neon"].map((variant) => <option key={variant} value={variant}>{variant}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function MediaLibrary() {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await mediaApi.list();
    setMedia(response.media);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  async function uploadFiles(files: FileList | File[]) {
    setError(null);
    try {
      for (const file of Array.from(files)) await mediaApi.upload(file);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  async function remove(id: string) {
    await mediaApi.remove(id);
    await load();
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Media</h1>
          <p className="muted">Images and logos stored on the backend server.</p>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <label
        className="dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void uploadFiles(event.dataTransfer.files);
        }}
      >
        <Upload size={28} />
        <strong>Drop images here</strong>
        <span className="muted">PNG, JPG, SVG, or WebP</span>
        <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" multiple hidden onChange={(event) => event.target.files && void uploadFiles(event.target.files)} />
      </label>
      <section className="media-grid" style={{ marginTop: 18 }}>
        {media.map((item) => (
          <article className="media-card" key={item.id}>
            <div className="media-thumb"><img src={mediaApi.mediaUrl(item.url)} alt="" /></div>
            <footer>
              <strong>{item.originalFilename}</strong>
              <span className="muted">{item.width || "?"} × {item.height || "?"}</span>
              <button className="button danger" onClick={() => void remove(item.id)}><Trash2 size={16} /> Delete</button>
            </footer>
          </article>
        ))}
      </section>
    </>
  );
}

function OverlayPage({ test }: { test: boolean }) {
  const { overlayId } = useParams();
  const [overlay, setOverlay] = useState<PresetSummary | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!overlayId) return;
    void overlayApi.get(overlayId).then((response) => setOverlay(response.overlay)).catch((err) => setError(err.message));
    const socket = io(WS_URL, {
      transports: ["websocket", "polling"],
      auth: { role: "overlay", overlayId },
      query: { role: "overlay", overlayId }
    });
    socket.on("connect", () => setConnection("connected"));
    socket.on("disconnect", () => setConnection("disconnected"));
    socket.on("connect_error", () => setConnection("disconnected"));
    socket.on("state:update", (payload: PresetSummary) => setOverlay(payload));
    return () => {
      socket.disconnect();
    };
  }, [overlayId]);

  if (test) {
    return (
      <div className="overlay-test-page">
        <div className="page-title">
          <div>
            <h1>Overlay test</h1>
            <p className="muted">{overlayId} · {connection}</p>
          </div>
          <Link className="button" to={overlay ? `/overlay/${overlay.publicId}` : "#"} target="_blank">OBS route</Link>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <div className="overlay-test-frame">
          {overlay ? <OverlayRenderer type={overlay.type} state={overlay.state} safeArea /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="overlay-page">
      {overlay ? <OverlayRenderer type={overlay.type} state={overlay.state} /> : null}
      {error ? <span style={{ color: "transparent" }}>{error}</span> : null}
    </div>
  );
}

function demoSoccerState(): SoccerState {
  const state = createDefaultSoccerState("District Championship");
  state.score.home = 2;
  state.score.away = 1;
  state.clock.running = true;
  state.clock.startedAtMs = Date.now() - 34 * 60 * 1000;
  state.clock.baseSeconds = 0;
  return state;
}

function isSoccerState(state: PresetState): state is SoccerState {
  return "score" in state && "clock" in state;
}

function isChurchState(state: PresetState): state is ChurchState {
  return "slides" in state;
}
