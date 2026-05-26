import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import {
  Check,
  Copy,
  Image,
  LayoutDashboard,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RotateCcw,
  Square,
  Sun,
  Trash2,
  Upload,
  Users
} from "lucide-react";
import {
  computeClockSeconds,
  createDefaultChurchState,
  createDefaultSoccerState,
  defaultTeam,
  formatClock,
  parseRoster,
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
  type SoccerLabOverlay,
  type SoccerOverlayPackage,
  type SoccerState,
  type SoccerTextAnimationField,
  type StyleVariant,
  type TeamLibraryEntry
} from "@openoverlay/shared";
import { getElementById, OverlayRenderer } from "./components/OverlayRenderer";
import { WS_URL, authApi, mediaApi, overlayApi, presetApi, teamApi, type MediaItem, type User } from "./lib/api";
import { useDebouncedCallback } from "./lib/hooks";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

interface PromptDialogOptions {
  title: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  inputType?: string;
}

type Theme = "light" | "dark";
type SoccerEditorTab = "match" | "live" | "setup";

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const PromptDialogContext = createContext<((options: PromptDialogOptions) => Promise<string | null>) | null>(null);
const ThemeContext = createContext<ThemeContextValue | null>(null);
const defaultSoccerEditorTabs: SoccerEditorTab[] = ["match", "live", "setup"];
const soccerTabLabels: Record<SoccerEditorTab, string> = { match: "Match", live: "Live", setup: "Setup" };

const THEME_STORAGE_KEY = "openoverlay:theme";
const SIDEBAR_WIDTH_STORAGE_KEY = "openoverlay:sidebar-width";
const SIDEBAR_MIN_WIDTH = 168;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_DEFAULT_WIDTH = 208;

export function App() {
  return (
    <ThemeProvider>
      <PromptDialogProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login mode="login" />} />
            <Route path="/signup" element={<Login mode="signup" />} />
            <Route path="/overlay/:overlayId" element={<OverlayPage test={false} />} />
            <Route path="/overlay-test/:overlayId" element={<OverlayPage test />} />
            <Route path="/dash" element={<RequireAuth><AppShell><Dashboard /></AppShell></RequireAuth>} />
            <Route path="/dash/teams" element={<RequireAuth><AppShell><TeamsLibrary /></AppShell></RequireAuth>} />
            <Route path="/dash/media" element={<RequireAuth><AppShell><MediaLibrary /></AppShell></RequireAuth>} />
            <Route path="/dash/presets/:presetId" element={<RequireAuth><AppShell><PresetEditor /></AppShell></RequireAuth>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </PromptDialogProvider>
    </ThemeProvider>
  );
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage may be unavailable; safe to ignore
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((value) => (value === "dark" ? "light" : "dark")), []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("Theme context missing");
  return ctx;
}

function useResizableSidebar() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, stored));
  });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
    } catch {
      // ignore
    }
  }, [width]);

  const startDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setResizing(true);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    function onMove(moveEvent: MouseEvent) {
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, moveEvent.clientX));
      setWidth(next);
    }
    function onUp() {
      setResizing(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return { width, resizing, startDrag };
}

function PromptDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<PromptDialogOptions | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const close = useCallback((result: string | null) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setDialog(null);
    setValue("");
  }, []);

  const prompt = useCallback((options: PromptDialogOptions) => {
    resolverRef.current?.(null);
    setValue(options.defaultValue ?? "");
    setDialog(options);
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const id = window.setTimeout(() => inputRef.current?.select(), 0);
    return () => window.clearTimeout(id);
  }, [dialog]);

  useEffect(() => () => resolverRef.current?.(null), []);

  return (
    <PromptDialogContext.Provider value={prompt}>
      {children}
      {dialog ? (
        <div className="prompt-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) close(null);
        }}>
          <form
            className="prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              close(value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") close(null);
            }}
          >
            <h2 id="prompt-dialog-title">{dialog.title}</h2>
            <label className="field">
              <span>{dialog.label}</span>
              <input
                ref={inputRef}
                type={dialog.inputType || "text"}
                value={value}
                placeholder={dialog.placeholder}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <div className="control-row prompt-actions">
              <button className="button" type="button" onClick={() => close(null)}>Cancel</button>
              <button className="button primary" type="submit">{dialog.submitLabel || "OK"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </PromptDialogContext.Provider>
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

function usePromptDialog() {
  const ctx = useContext(PromptDialogContext);
  if (!ctx) throw new Error("Prompt dialog context missing");
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
          <img className="brand-mark" src="/openoverlay-mark.svg" alt="" aria-hidden="true" />
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
      <div className="auth-stack">
        <Link to="/" className="brand auth-brand">
          <img className="brand-mark" src="/openoverlay-mark.svg" alt="" aria-hidden="true" />
          <span>OpenOverlay</span>
        </Link>
        <form className="auth-panel" onSubmit={submit}>
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
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { logout, user } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const { width: sidebarWidth, resizing, startDrag } = useResizableSidebar();
  const [games, setGames] = useState<PresetSummary[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [presetMenu, setPresetMenu] = useState<{ game: PresetSummary; x: number; y: number } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    void presetApi.list().then((response) => setGames(response.presets)).catch(() => setGames([]));
  }, []);

  useEffect(() => {
    if (!presetMenu) return;
    function closeMenu() {
      setPresetMenu(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [presetMenu]);

  function openPresetMenu(game: PresetSummary, x: number, y: number) {
    setPresetMenu({ game, x, y });
  }

  async function duplicateSidebarPreset(game: PresetSummary) {
    const response = await presetApi.duplicate(game.id);
    setGames((current) => [response.preset, ...current]);
    setPresetMenu(null);
    navigate(`/dash/presets/${response.preset.id}`);
  }

  async function deleteSidebarPreset(game: PresetSummary) {
    if (!window.confirm(`Delete ${game.name}?`)) return;
    await presetApi.remove(game.id);
    setGames((current) => current.filter((item) => item.id !== game.id));
    setPresetMenu(null);
    if (location.pathname.includes(`/dash/presets/${game.id}`)) navigate("/dash");
  }

  const shellStyle = { "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties;
  const shellClass = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    resizing ? "is-resizing" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClass} style={shellStyle}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <Link to="/dash" className="brand sidebar-brand" aria-label="OpenOverlay dashboard">
            <img className="brand-mark" src="/openoverlay-mark.svg" alt="" aria-hidden="true" />
            <span className="sidebar-brand-text">OpenOverlay</span>
          </Link>
          <button
            className="sidebar-collapse-toggle"
            type="button"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={19} strokeWidth={2.2} /> : <PanelLeftClose size={19} strokeWidth={2.2} />}
          </button>
        </div>
        <nav className="sidebar-nav" aria-hidden={sidebarCollapsed}>
          <NavLink to="/dash" end><LayoutDashboard size={18} /> <span className="nav-label">Games</span></NavLink>
          {games.length > 0 ? (
            <div className="sidebar-subnav" aria-label="Active games">
              {games.map((game) => (
                <NavLink
                  key={game.id}
                  to={`/dash/presets/${game.id}`}
                  onMouseDown={(event) => {
                    if (event.button !== 2) return;
                    event.preventDefault();
                    openPresetMenu(game, event.clientX, event.clientY);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openPresetMenu(game, event.clientX, event.clientY);
                  }}
                >
                  <span className="nav-label">{game.name}</span>
                </NavLink>
              ))}
            </div>
          ) : null}
          <NavLink to="/dash/teams"><Users size={18} /> <span className="nav-label">Teams</span></NavLink>
          <NavLink to="/dash/media"><Image size={18} /> <span className="nav-label">Media</span></NavLink>
        </nav>
        <div className="sidebar-account" aria-hidden={sidebarCollapsed}>
          <p className="muted">{user?.email}</p>
          <button
            className="sidebar-theme-toggle"
            type="button"
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={18} strokeWidth={2.2} /> : <Moon size={18} strokeWidth={2.2} />}
          </button>
          <button className="sidebar-logout" type="button" aria-label="Logout" title="Logout" onClick={() => void logout()}><LogOut size={20} strokeWidth={2.4} /></button>
        </div>
        {!sidebarCollapsed ? (
          <div
            className="sidebar-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onMouseDown={startDrag}
          />
        ) : null}
      </aside>
      {presetMenu ? (
        <div
          className="sidebar-preset-menu"
          style={{ left: presetMenu.x, top: presetMenu.y } as React.CSSProperties}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" onClick={() => void duplicateSidebarPreset(presetMenu.game)}><Copy size={15} /> Duplicate</button>
          <button type="button" className="danger" onClick={() => void deleteSidebarPreset(presetMenu.game)}><Trash2 size={15} /> Delete</button>
        </div>
      ) : null}
      <main className="main">{children}</main>
    </div>
  );
}

function Dashboard() {
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [type, setType] = useState<PresetType>("soccer");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const prompt = usePromptDialog();

  const load = useCallback(async () => {
    const response = await presetApi.list();
    setPresets(response.presets);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  async function createPreset() {
    const name = await prompt({
      title: type === "soccer" ? "New game" : "New service",
      label: type === "soccer" ? "Game name" : "Production name",
      defaultValue: type === "soccer" ? "Soccer Game" : type === "church" ? "Church Sunday" : "Custom",
      submitLabel: type === "soccer" ? "Create game" : "Create"
    });
    const trimmedName = name?.trim();
    if (!trimmedName) return;
    setError(null);
    try {
      const response = await presetApi.create(trimmedName, type);
      navigate(`/dash/presets/${response.preset.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create game");
    }
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Games</h1>
          <p className="muted">Game-day control rooms, service productions, and one-off overlay packages.</p>
        </div>
        <div className="control-row">
          <select className="number-input" value={type} onChange={(event) => setType(event.target.value as PresetType)}>
            <option value="soccer">Soccer</option>
            <option value="church">Church</option>
            <option value="custom">Custom</option>
          </select>
          <button className="button primary" onClick={() => void createPreset()}><Plus size={17} /> {type === "soccer" ? "New game" : "New production"}</button>
        </div>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <section className="preset-grid">
        {presets.map((preset) => (
          <article className="preset-card" key={preset.id}>
            <h2>{preset.name}</h2>
            <p>{preset.type === "soccer" ? "soccer game" : `${preset.type} production`}</p>
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

function TeamsLibrary() {
  const [teams, setTeams] = useState<TeamLibraryEntry[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamLibraryEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const prompt = usePromptDialog();

  const load = useCallback(async () => {
    const [teamsResponse, mediaResponse] = await Promise.all([teamApi.list(), mediaApi.list()]);
    setTeams(teamsResponse.teams);
    setMedia(mediaResponse.media);
    setSelectedId((current) => current ?? teamsResponse.teams[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  useEffect(() => {
    const selected = teams.find((team) => team.id === selectedId) || null;
    setDraft(selected ? structuredClone(selected) : null);
  }, [selectedId, teams]);

  const debouncedSaveTeam = useDebouncedCallback((team: TeamLibraryEntry) => {
    setSaveStatus("saving");
    void teamApi.patch(team.id, team).then((response) => {
      setTeams((current) => current.map((item) => (item.id === response.team.id ? response.team : item)));
      setSaveStatus("saved");
    }).catch((err) => {
      setSaveStatus("error");
      setError(err instanceof Error ? err.message : "Could not autosave team");
    });
  }, 500);

  async function createTeam() {
    const name = await prompt({
      title: "New team",
      label: "Team name",
      defaultValue: "New Team",
      submitLabel: "Create team"
    });
    const trimmedName = name?.trim();
    if (!trimmedName) return;
    const displayName = titleCaseFirst(trimmedName);
    setError(null);
    try {
      const response = await teamApi.create({
        fullName: displayName,
        shortName: makeAbbreviation(displayName),
        abbreviation: makeAbbreviation(displayName)
      });
      setTeams((current) => [response.team, ...current]);
      setSelectedId(response.team.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create team");
    }
  }

  function updateDraft(patch: Partial<SoccerState["home"]>) {
    setError(null);
    setDraft((current) => {
      if (!current) return current;
      const next = mergeTeamPatch(current, patch);
      setSaveStatus("saving");
      debouncedSaveTeam(next);
      return next;
    });
  }

  async function deleteTeam(id: string) {
    setError(null);
    try {
      await teamApi.remove(id);
      const remaining = teams.filter((team) => team.id !== id);
      setTeams(remaining);
      setSelectedId(remaining[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete team");
    }
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Teams</h1>
          <p className="muted">Reusable team profiles for names, logos, colors, records, and rosters.</p>
        </div>
        <button className="button primary" onClick={() => void createTeam()}><Plus size={17} /> New team</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className={`team-library-layout ${draft ? "" : "empty"}`}>
        <section className="team-list">
          {teams.length === 0 ? (
            <div className="panel">
              <p className="muted">No teams yet.</p>
            </div>
          ) : null}
          {teams.map((team) => (
            <button
              key={team.id}
              className={`team-list-item ${team.id === selectedId ? "active" : ""}`}
              style={{
                "--team-primary": team.primaryColor,
                "--team-secondary": team.secondaryColor
              } as React.CSSProperties}
              onClick={() => {
                setSaveStatus("idle");
                setSelectedId(team.id);
              }}
            >
              <TeamLogo team={team} />
              <span>
                <strong>{titleCaseFirst(team.fullName)}</strong>
                <small>{team.abbreviation} · {formatRecord(team.record)}</small>
              </span>
            </button>
          ))}
        </section>
        {draft ? (
          <section className="panel team-editor-panel">
            <div className="panel-heading">
              <div>
                <h2>{titleCaseFirst(draft.fullName)}</h2>
              </div>
              <div className="control-row">
                <button className="button danger" onClick={() => void deleteTeam(draft.id)}><Trash2 size={17} /> Delete</button>
              </div>
            </div>
            <TeamFields team={draft} media={media} onChange={updateDraft} />
            <p className="muted autosave-status">{saveStatusLabel(saveStatus, draft.updatedAt)}</p>
          </section>
        ) : null}
      </div>
    </>
  );
}

function PresetEditor() {
  const { presetId } = useParams();
  const [preset, setPreset] = useState<PresetSummary | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [teams, setTeams] = useState<TeamLibraryEntry[]>([]);
  const [tab, setTab] = useState("live");
  const [soccerTabOrder, setSoccerTabOrder] = useState<SoccerEditorTab[]>(defaultSoccerEditorTabs);
  const [draggedSoccerTab, setDraggedSoccerTab] = useState<SoccerEditorTab | null>(null);
  const [soccerPreviewSurface, setSoccerPreviewSurface] = useState<SoccerState["soccerPackage"]["surface"]>("checker");
  const draggedSoccerTabRef = useRef<SoccerEditorTab | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PresetState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pendingSoccerTextUpdate, setPendingSoccerTextUpdate] = useState<{ state: SoccerState; fields: SoccerTextAnimationField[] } | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const selectedElement = useMemo(() => {
    if (!preset) return undefined;
    if (isSoccerState(preset.state)) return undefined;
    if (isChurchState(preset.state)) return preset.state.elements.lowerThird;
    return undefined;
  }, [preset]);

  const load = useCallback(async () => {
    if (!presetId) return;
    const [presetResponse, mediaResponse, teamsResponse] = await Promise.all([presetApi.get(presetId), mediaApi.list(), teamApi.list()]);
    setPreset(presetResponse.preset);
    setHistory([presetResponse.preset.state]);
    setHistoryIndex(0);
    setMedia(mediaResponse.media);
    setTeams(teamsResponse.teams);
  }, [presetId]);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  useEffect(() => {
    if (!preset) return;
    if (preset.type === "soccer" && !defaultSoccerEditorTabs.includes(tab as SoccerEditorTab)) setTab("live");
    if (preset.type !== "soccer" && !["slides", "style"].includes(tab)) setTab("slides");
  }, [preset, tab]);

  useEffect(() => {
    if (preset?.state && isSoccerState(preset.state)) {
      setSoccerPreviewSurface(preset.state.soccerPackage.surface);
    }
  }, [preset?.id]);

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

  const restoreHistory = useCallback((direction: "undo" | "redo") => {
    if (!preset) return;
    const nextIndex = direction === "redo" ? Math.min(history.length - 1, historyIndex + 1) : Math.max(0, historyIndex - 1);
    const nextState = history[nextIndex];
    if (!nextState || nextIndex === historyIndex) return;
    setHistoryIndex(nextIndex);
    setPreset({ ...preset, state: structuredClone(nextState) });
    void presetApi.patch(preset.id, { state: nextState });
  }, [history, historyIndex, preset]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z" || !preset) return;
      event.preventDefault();
      restoreHistory(event.shiftKey ? "redo" : "undo");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preset, restoreHistory]);

  async function runAction(action: string, payload: Record<string, unknown> = {}) {
    if (!preset) return;
    const response = await presetApi.action(preset.id, action, payload);
    setPreset(response.preset);
    setHistory((current) => {
      const trimmed = current.slice(0, historyIndex + 1);
      return [...trimmed, structuredClone(response.preset.state)].slice(-60);
    });
    setHistoryIndex((index) => Math.min(index + 1, 59));
  }

  if (!preset) return <div>Loading game...</div>;
  const overlayUrl = `${window.location.origin}/overlay/${preset.publicId}`;
  const soccerState = preset.type === "soccer" && isSoccerState(preset.state) ? preset.state : null;
  const tabs = soccerState ? soccerTabOrder : ["slides", "style"];
  const isSoccerEditor = Boolean(soccerState);
  const tabLabels: Record<string, string> = { ...soccerTabLabels, slides: "slides", style: "style" };
  function startSoccerTabDrag(sourceTab: SoccerEditorTab) {
    draggedSoccerTabRef.current = sourceTab;
    setDraggedSoccerTab(sourceTab);
  }
  function clearSoccerTabDrag() {
    draggedSoccerTabRef.current = null;
    setDraggedSoccerTab(null);
  }
  function reorderSoccerTab(targetTab: SoccerEditorTab) {
    const sourceTab = draggedSoccerTabRef.current;
    if (!sourceTab || sourceTab === targetTab) return;
    setSoccerTabOrder((current) => {
      const next = current.filter((item) => item !== sourceTab);
      const targetIndex = next.indexOf(targetTab);
      next.splice(targetIndex < 0 ? next.length : targetIndex, 0, sourceTab);
      return next;
    });
    clearSoccerTabDrag();
  }
  const tabButtons = (
    <div className="tabs">
      {tabs.map((item) => (
        <button
          key={item}
          className={`tab ${tab === item ? "active" : ""} ${draggedSoccerTab === item ? "dragging" : ""}`}
          data-soccer-tab={soccerState ? item : undefined}
          type="button"
          draggable={Boolean(soccerState)}
          onClick={() => setTab(item)}
          onPointerDown={(event) => {
            if (!soccerState || event.button !== 0) return;
            startSoccerTabDrag(item as SoccerEditorTab);
          }}
          onPointerEnter={() => {
            if (!soccerState) return;
            reorderSoccerTab(item as SoccerEditorTab);
          }}
          onPointerMove={() => {
            if (!soccerState) return;
            reorderSoccerTab(item as SoccerEditorTab);
          }}
          onPointerUp={clearSoccerTabDrag}
          onMouseDown={(event) => {
            if (!soccerState || event.button !== 0) return;
            startSoccerTabDrag(item as SoccerEditorTab);
          }}
          onMouseEnter={() => {
            if (!soccerState) return;
            reorderSoccerTab(item as SoccerEditorTab);
          }}
          onMouseMove={() => {
            if (!soccerState) return;
            reorderSoccerTab(item as SoccerEditorTab);
          }}
          onMouseUp={clearSoccerTabDrag}
          onDragStart={() => soccerState ? startSoccerTabDrag(item as SoccerEditorTab) : undefined}
          onDragOver={(event) => {
            if (!soccerState) return;
            event.preventDefault();
          }}
          onDrop={(event) => {
            if (!soccerState) return;
            event.preventDefault();
            reorderSoccerTab(item as SoccerEditorTab);
          }}
          onDragEnd={clearSoccerTabDrag}
        >
          {tabLabels[item]}
        </button>
      ))}
    </div>
  );

  function updateSoccerClock(patch: Partial<SoccerState["clock"]>) {
    if (!soccerState) return;
    commitState({ ...soccerState, clock: { ...soccerState.clock, ...patch } });
  }

  function updateSoccerPackage(patch: Partial<SoccerState["soccerPackage"]>) {
    if (!soccerState) return;
    commitState({ ...soccerState, soccerPackage: { ...soccerState.soccerPackage, ...patch } });
  }

  function commitSoccerMatchState(nextState: SoccerState, changedFields: SoccerTextAnimationField[]) {
    const visibleFields = uniqueSoccerTextFields(changedFields.filter((field) => soccerTextFieldIsVisible(field, soccerState?.soccerPackage.activeOverlay ?? null, soccerState)));
    if (visibleFields.length > 0 || pendingSoccerTextUpdate) {
      commitState(nextState, false);
      setPendingSoccerTextUpdate((current) => ({
        state: nextState,
        fields: uniqueSoccerTextFields([...(current?.fields ?? []), ...visibleFields])
      }));
      return;
    }
    commitState(nextState);
  }

  function updateSoccerMatchPackage(patch: Partial<SoccerState["soccerPackage"]>, changedFields: SoccerTextAnimationField[] = []) {
    if (!soccerState) return;
    commitSoccerMatchState({ ...soccerState, soccerPackage: { ...soccerState.soccerPackage, ...patch } }, changedFields);
  }

  function applyPendingSoccerTextUpdate() {
    if (!pendingSoccerTextUpdate) return;
    const nextState: SoccerState = {
      ...pendingSoccerTextUpdate.state,
      soccerPackage: {
        ...pendingSoccerTextUpdate.state.soccerPackage,
        textAnimation: {
          id: Date.now(),
          fields: pendingSoccerTextUpdate.fields
        }
      }
    };
    setPendingSoccerTextUpdate(null);
    commitState(nextState);
  }

  async function copyOverlayUrl() {
    try {
      await navigator.clipboard.writeText(overlayUrl);
      setError(null);
    } catch {
      setError("Could not copy output URL.");
    }
  }

  return (
    <>
      <div className="page-title compact">
        <div>
          <h1>{preset.name}</h1>
          <p className="muted preset-meta">
            <span>{preset.type === "soccer" ? "soccer game" : `${preset.type} production`}</span>
            <button className="inline-copy-button" type="button" onClick={() => void copyOverlayUrl()}><Copy size={14} /> Copy output URL</button>
          </p>
        </div>
        <div className="status-row">
          <span className={`status-pill ${connection === "connected" ? "ok" : "warn"}`}>{connection}</span>
          <span className="status-pill ok">{preset.overlayClientCount || 0} overlay clients</span>
        </div>
      </div>

      {connection !== "connected" ? <div className="error">Backend or overlay WebSocket is disconnected. The overlay will keep showing its last known state.</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <div className={`editor-layout ${isSoccerEditor ? "live-editor-layout" : ""}`}>
        {soccerState ? (
          <>
            <SoccerLabOverlayControls state={soccerState} updatePackage={updateSoccerPackage} runAction={runAction} />
            <section className="preview-column live-preview-pane">
              <OutputPreviewFrame src={overlayUrl} title={`${preset.name} output preview`} surface={soccerPreviewSurface} />
              {pendingSoccerTextUpdate ? <SoccerPreviewUpdatePrompt onApply={applyPendingSoccerTextUpdate} /> : null}
            </section>
            <SoccerBottomControlPanel
              state={soccerState}
              teams={teams}
              activeTab={tab}
              tabButtons={tabButtons}
              updateClock={updateSoccerClock}
              updatePackage={updateSoccerPackage}
              updateMatchPackage={updateSoccerMatchPackage}
              previewSurface={soccerPreviewSurface}
              setPreviewSurface={setSoccerPreviewSurface}
              commitState={commitState}
              commitMatchState={commitSoccerMatchState}
              runAction={runAction}
            />
          </>
        ) : (
          <>
          <section className="preview-column">
            <div className="preview-workspace">
              <OutputPreviewFrame src={overlayUrl} title={`${preset.name} output preview`} surface={soccerPreviewSurface} />
            </div>
          </section>
          <aside className="inspector">
            {tabButtons}
            {soccerState ? (
              <SoccerControls state={soccerState} media={media} teams={teams} tab={tab} commitState={commitState} />
            ) : null}
            {preset.type === "church" && isChurchState(preset.state) ? (
              <ChurchControls state={preset.state} media={media} tab={tab} commitState={commitState} />
            ) : null}
            {selectedElement ? <ElementInspector state={preset.state} element={selectedElement} commitState={commitState} /> : null}
          </aside>
          </>
        )}
      </div>
    </>
  );
}

function OutputPreviewFrame({ src, title, surface }: { src: string; title: string; surface: SoccerState["soccerPackage"]["surface"] }) {
  return (
    <div className={`preview-frame preview-surface-${surface}`}>
      <iframe
        className="output-preview-iframe"
        src={src}
        title={title}
        loading="eager"
      />
    </div>
  );
}

function SoccerPreviewUpdatePrompt({ onApply }: { onApply: () => void }) {
  return (
    <div className="preview-update-prompt" role="status">
      <span>Changes were made. Update?</span>
      <button className="button icon-only dark" type="button" aria-label="Update displayed overlay" title="Update displayed overlay" onClick={onApply}>
        <Check size={16} strokeWidth={2.6} />
      </button>
    </div>
  );
}

function SoccerControls({
  state,
  media,
  teams,
  tab,
  commitState
}: {
  state: SoccerState;
  media: MediaItem[];
  teams: TeamLibraryEntry[];
  tab: string;
  commitState: (state: PresetState) => void;
}) {
  function update(patch: Partial<SoccerState>) {
    commitState({ ...state, ...patch });
  }

  function updateTeam(side: "home" | "away", patch: Partial<SoccerState["home"]>) {
    update({ [side]: mergeTeamPatch(state[side], patch) } as Partial<SoccerState>);
  }

  function applySavedTeam(side: "home" | "away", teamId: string) {
    const team = teams.find((candidate) => candidate.id === teamId);
    if (!team) return;
    update({ [side]: teamLibraryToSoccerTeam(team) } as Partial<SoccerState>);
  }

  function clearTeam(side: "home" | "away") {
    const blank = defaultTeam(side);
    update({
      [side]: {
        ...blank,
        fullName: side === "home" ? "Home Team" : "Away Team",
        shortName: side === "home" ? "HOME" : "AWAY",
        abbreviation: side === "home" ? "HOME" : "AWAY",
        rosterText: "",
        roster: [],
        coach: "",
        schoolName: "",
        record: { wins: 0, losses: 0, draws: 0 }
      }
    } as Partial<SoccerState>);
  }

  function refreshTeam(side: "home" | "away") {
    const match = findSavedTeamMatch(state[side], teams);
    if (match) applySavedTeam(side, match.id);
  }

  function swapTeams() {
    update({ home: state.away, away: state.home });
  }

  function updateGameInfo(patch: Partial<Pick<SoccerState, "gameTitle" | "productionName" | "scheduledAt">>) {
    update(patch);
  }

  function updatePackage(patch: Partial<SoccerState["soccerPackage"]>) {
    update({ soccerPackage: { ...state.soccerPackage, ...patch } });
  }

  if (tab === "setup") {
    return (
      <>
        <div className="panel setup-panel">
          <h2>Game setup</h2>
          <div className="form-grid">
            <label className="field">
              <span>Game title</span>
              <input value={state.gameTitle} onChange={(event) => updateGameInfo({ gameTitle: event.target.value })} />
            </label>
            <div className="two-col">
              <label className="field">
                <span>Production</span>
                <input value={state.productionName} onChange={(event) => updateGameInfo({ productionName: event.target.value })} />
              </label>
              <label className="field">
                <span>Scheduled</span>
                <input type="datetime-local" value={dateTimeLocalValue(state.scheduledAt)} onChange={(event) => {
                  const nextDate = new Date(event.target.value);
                  if (!Number.isNaN(nextDate.getTime())) updateGameInfo({ scheduledAt: nextDate.toISOString() });
                }} />
              </label>
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>Teams</h2>
              <p className="muted">Saved teams are copied into this game, so game-day edits stay local to this game.</p>
            </div>
            <button className="button" type="button" onClick={swapTeams}>Swap teams</button>
          </div>
          <div className="two-col">
            <TeamAssignmentCard side="home" team={state.home} teams={teams} onSelect={(id) => applySavedTeam("home", id)} onClear={() => clearTeam("home")} onRefresh={() => refreshTeam("home")} />
            <TeamAssignmentCard side="away" team={state.away} teams={teams} onSelect={(id) => applySavedTeam("away", id)} onClear={() => clearTeam("away")} onRefresh={() => refreshTeam("away")} />
          </div>
        </div>
        <TeamPanel title="Home team" side="home" team={state.home} media={media} onChange={(patch) => updateTeam("home", patch)} />
        <TeamPanel title="Away team" side="away" team={state.away} media={media} onChange={(patch) => updateTeam("away", patch)} />
      </>
    );
  }

  if (tab === "design") {
    return (
      <>
        <StylePanel state={state} commitState={commitState} />
        <SoccerPackageStylePanel state={state} updatePackage={updatePackage} />
        <div className="panel">
          <h2>Elements</h2>
          <p className="muted">Drag the soccer package in the preview or adjust the selected element below.</p>
        </div>
      </>
    );
  }

  return null;
}

function SoccerBottomControlPanel({
  state,
  teams,
  activeTab,
  tabButtons,
  updateClock,
  updatePackage,
  updateMatchPackage,
  previewSurface,
  setPreviewSurface,
  commitState,
  commitMatchState,
  runAction
}: {
  state: SoccerState;
  teams: TeamLibraryEntry[];
  activeTab: string;
  tabButtons: React.ReactNode;
  updateClock: (patch: Partial<SoccerState["clock"]>) => void;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  updateMatchPackage: (patch: Partial<SoccerState["soccerPackage"]>, changedFields?: SoccerTextAnimationField[]) => void;
  previewSurface: SoccerState["soccerPackage"]["surface"];
  setPreviewSurface: (surface: SoccerState["soccerPackage"]["surface"]) => void;
  commitState: (state: PresetState) => void;
  commitMatchState: (state: SoccerState, changedFields: SoccerTextAnimationField[]) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <div className="panel soccer-bottom-control-panel">
      <div className="bottom-control-tabs">{tabButtons}</div>
      {activeTab === "match" ? (
        <div className="match-control-stack">
          <SoccerLiveSetupPanel state={state} teams={teams} commitMatchState={commitMatchState} />
          <SoccerMatchupTextPanel state={state} commitMatchState={commitMatchState} />
          <SoccerTextBugPanel state={state} updatePackage={updateMatchPackage} />
          <SoccerCountdownPanel state={state} updatePackage={updatePackage} runAction={runAction} />
        </div>
      ) : null}
      {activeTab === "setup" ? (
        <SoccerPackageSetupPanel state={state} updatePackage={updatePackage} previewSurface={previewSurface} setPreviewSurface={setPreviewSurface} />
      ) : null}
      {activeTab === "live" ? (
        <div className="live-control-stack">
          <SoccerScoreClockPanel state={state} updateClock={updateClock} runAction={runAction} />
          <SoccerCountdownPanel state={state} updatePackage={updatePackage} runAction={runAction} />
        </div>
      ) : null}
    </div>
  );
}

function SoccerLiveSetupPanel({
  state,
  teams,
  commitMatchState
}: {
  state: SoccerState;
  teams: TeamLibraryEntry[];
  commitMatchState: (state: SoccerState, changedFields: SoccerTextAnimationField[]) => void;
}) {
  const homeMatch = findSavedTeamMatch(state.home, teams);
  const awayMatch = findSavedTeamMatch(state.away, teams);

  function applySavedTeam(side: "home" | "away", teamId: string) {
    const team = teams.find((candidate) => candidate.id === teamId);
    if (!team) return;
    commitMatchState({ ...state, [side]: teamLibraryToSoccerTeam(team) } as SoccerState, soccerTeamTextFields(side, state));
  }

  function swapTeams() {
    commitMatchState({ ...state, home: state.away, away: state.home }, soccerTeamTextFields("home", state).concat(soccerTeamTextFields("away", state)));
  }

  return (
    <section className="control-section live-setup-panel">
      <div className="panel-heading">
        <h2>Match setup</h2>
        <button className="button" type="button" onClick={swapTeams}>Swap teams</button>
      </div>
      <div className="two-col">
        <label className="field">
          <span>Home team</span>
          <select value={homeMatch?.id ?? ""} onChange={(event) => applySavedTeam("home", event.target.value)}>
            <option value="">{teams.length ? "Select saved team" : "No saved teams"}</option>
            {teams.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Away team</span>
          <select value={awayMatch?.id ?? ""} onChange={(event) => applySavedTeam("away", event.target.value)}>
            <option value="">{teams.length ? "Select saved team" : "No saved teams"}</option>
            {teams.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}

const soccerPackageColorFields: Record<SoccerOverlayPackage, Array<{ key: string; label: string }>> = {
  classic: [
    { key: "bg", label: "Background" },
    { key: "soft", label: "Soft fill" },
    { key: "ink", label: "Ink" },
    { key: "muted", label: "Muted text" },
    { key: "faint", label: "Faint rule" },
    { key: "red", label: "Accent red" },
    { key: "rule", label: "Rule" },
    { key: "panelGray", label: "Panel gray" }
  ],
  rounded: [
    { key: "ink", label: "Ink" },
    { key: "muted", label: "Muted text" },
    { key: "line", label: "Line" },
    { key: "gold", label: "Gold" },
    { key: "maroon", label: "Maroon" },
    { key: "wine", label: "Wine" },
    { key: "ivory", label: "Ivory" },
    { key: "sky", label: "Sky" },
    { key: "blue", label: "Blue" },
    { key: "red", label: "Red" }
  ]
};

function SoccerPackageSetupPanel({
  state,
  updatePackage,
  previewSurface,
  setPreviewSurface
}: {
  state: SoccerState;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  previewSurface: SoccerState["soccerPackage"]["surface"];
  setPreviewSurface: (surface: SoccerState["soccerPackage"]["surface"]) => void;
}) {
  const packageName = state.soccerPackage.overlayPackage;
  const activeColors = state.soccerPackage.colorBanks[packageName];

  function updateColor(key: string, value: string) {
    updatePackage({
      colorBanks: {
        ...state.soccerPackage.colorBanks,
        [packageName]: {
          ...activeColors,
          [key]: value
        }
      }
    });
  }

  return (
    <div className="setup-control-stack">
      <section className="control-section">
        <h2>Design</h2>
        <div className="form-grid">
          <label className="field">
            <span>Package</span>
            <select value={packageName} onChange={(event) => updatePackage({ overlayPackage: event.target.value as SoccerOverlayPackage })}>
              <option value="classic">Classic</option>
              <option value="rounded">Rounded</option>
            </select>
          </label>
          <div className="two-col">
            <label className="field">
              <span>Preview background</span>
              <select value={previewSurface} onChange={(event) => setPreviewSurface(event.target.value as SoccerState["soccerPackage"]["surface"])}>
                <option value="pitch">Pitch</option>
                <option value="checker">Checker</option>
                <option value="studio">Studio</option>
              </select>
            </label>
            <label className="control-row">
              <input type="checkbox" checked={state.soccerPackage.packageBackground} onChange={(event) => updatePackage({ packageBackground: event.target.checked })} />
              Package background
            </label>
          </div>
          <label className="field">
            <span>Background opacity</span>
            <input type="range" min="0" max="100" value={Math.round(state.soccerPackage.packageBackgroundOpacity * 100)} onChange={(event) => updatePackage({ packageBackgroundOpacity: Number(event.target.value) / 100 })} />
          </label>
        </div>
      </section>
      <section className="control-section">
        <h2>Colors</h2>
        <div className="package-color-grid">
          {soccerPackageColorFields[packageName].map((field) => (
            <label key={field.key} className="field color-swatch-field package-color-field">
              <span>{field.label}</span>
              <input type="color" value={activeColors[field.key]} onInput={(event) => updateColor(field.key, event.currentTarget.value)} onChange={(event) => updateColor(field.key, event.target.value)} />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

function SoccerMatchupTextPanel({ state, commitMatchState }: { state: SoccerState; commitMatchState: (state: SoccerState, changedFields: SoccerTextAnimationField[]) => void }) {
  function update(patch: Partial<Pick<SoccerState, "gameTitle" | "productionName">>, changedFields: SoccerTextAnimationField[]) {
    commitMatchState({ ...state, ...patch }, changedFields);
  }

  return (
    <section className="control-section">
      <h2>Matchup text</h2>
      <div className="form-grid">
        <label className="field">
          <span>Title</span>
          <input value={state.gameTitle} onChange={(event) => update({ gameTitle: event.target.value }, ["event-title"])} />
        </label>
        <label className="field">
          <span>Subtitle</span>
          <input value={state.productionName} onChange={(event) => update({ productionName: event.target.value }, ["production-name"])} />
        </label>
      </div>
    </section>
  );
}

function SoccerTextBugPanel({ state, updatePackage }: { state: SoccerState; updatePackage: (patch: Partial<SoccerState["soccerPackage"]>, changedFields?: SoccerTextAnimationField[]) => void }) {
  return (
    <section className="control-section">
      <h2>Text bugs</h2>
      <div className="form-grid">
        <label className="field"><span>1-line text</span><input value={state.soccerPackage.oneLineText} onChange={(event) => updatePackage({ oneLineText: event.target.value }, ["one-line"])} /></label>
        <PositionSelect value={state.soccerPackage.oneLinePosition} onChange={(value) => updatePackage({ oneLinePosition: value })} />
        <label className="field"><span>2-line top</span><input value={state.soccerPackage.twoLineTextA} onChange={(event) => updatePackage({ twoLineTextA: event.target.value }, ["two-line-a"])} /></label>
        <label className="field"><span>2-line bottom</span><input value={state.soccerPackage.twoLineTextB} onChange={(event) => updatePackage({ twoLineTextB: event.target.value }, ["two-line-b"])} /></label>
        <PositionSelect value={state.soccerPackage.twoLinePosition} onChange={(value) => updatePackage({ twoLinePosition: value })} />
      </div>
    </section>
  );
}

function SoccerCountdownPanel({
  state,
  updatePackage,
  runAction
}: {
  state: SoccerState;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  function updateCountdown(patch: Partial<SoccerState["soccerPackage"]["countdown"]>) {
    updatePackage({ countdown: { ...state.soccerPackage.countdown, ...patch } });
  }

  return (
    <section className="control-section countdown-panel">
      <h2>Countdown</h2>
      <div className="form-grid">
        <div className="control-row">
          <button
            className="button primary icon-toggle"
            type="button"
            aria-label={state.soccerPackage.countdown.running ? "Stop countdown" : "Start countdown"}
            title={state.soccerPackage.countdown.running ? "Stop countdown" : "Start countdown"}
            onClick={() => void runAction("countdown-toggle")}
          >
            {state.soccerPackage.countdown.running ? <Square size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} />}
          </button>
          <button className="button" type="button" onClick={() => updateCountdown({ seconds: 300, resetSeconds: 300, running: false, startedAtMs: null })}>5:00</button>
          <button className="button" type="button" onClick={() => updateCountdown({ seconds: 600, resetSeconds: 600, running: false, startedAtMs: null })}>10:00</button>
          <button className="button" type="button" onClick={() => void runAction("countdown-reset")}>Reset</button>
        </div>
        <div className="two-col">
          <label className="field">
            <span>Custom length</span>
            <input defaultValue={formatClock(state.soccerPackage.countdown.resetSeconds)} onBlur={(event) => {
              const seconds = parseClockTime(event.target.value);
              updateCountdown({ seconds, resetSeconds: seconds, running: false, startedAtMs: null });
            }} />
          </label>
          <label className="field">
            <span>Mode</span>
            <select value={state.soccerPackage.countdown.mode} onChange={(event) => updateCountdown({ mode: event.target.value as SoccerState["soccerPackage"]["countdown"]["mode"] })}>
              <option value="full">Full page</option>
              <option value="small">Small</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Position</span>
          <select value={state.soccerPackage.countdown.position} disabled={state.soccerPackage.countdown.mode !== "small"} onChange={(event) => updateCountdown({ position: event.target.value as PositionPreset })}>
            {positionOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}

function SoccerScoreClockPanel({
  state,
  updateClock,
  runAction
}: {
  state: SoccerState;
  updateClock: (patch: Partial<SoccerState["clock"]>) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const clockValue = formatClock(computeClockSeconds(state.clock));

  return (
    <div className="score-clock-panel">
      <section className="score-clock-section">
        <h2>Score</h2>
        <div className="two-col">
          <ScoreControls label={state.home.abbreviation} score={state.score.home} plus={() => runAction("home-score-plus")} minus={() => runAction("home-score-minus")} />
          <ScoreControls label={state.away.abbreviation} score={state.score.away} plus={() => runAction("away-score-plus")} minus={() => runAction("away-score-minus")} />
        </div>
      </section>
      <section className="score-clock-section">
        <h2>Clock</h2>
        <div className="control-row">
          <button
            className="button primary icon-toggle"
            type="button"
            aria-label={state.clock.running ? "Pause clock" : "Start clock"}
            title={state.clock.running ? "Pause clock" : "Start clock"}
            onClick={() => runAction("clock-toggle")}
          >
            {state.clock.running ? <Square size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} />}
          </button>
          <button className="button" type="button" onClick={() => runAction("clock-reset")}><RotateCcw size={15} /> Reset</button>
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
          <div className="two-col">
            <label className="field">
              <span>Stoppage minutes</span>
              <input type="number" min="0" value={state.clock.stoppageMinutes} onChange={(event) => updateClock({ stoppageMinutes: Math.max(0, Number(event.target.value)) })} />
            </label>
            <label className="control-row">
              <input type="checkbox" checked={state.clock.stopAtEnabled} onChange={(event) => updateClock({ stopAtEnabled: event.target.checked })} />
              Stop at enabled
            </label>
          </div>
          <label className="control-row">
            <input type="checkbox" checked={state.clock.showStoppage} onChange={(event) => updateClock({ showStoppage: event.target.checked })} />
            Show stoppage time
          </label>
        </div>
      </section>
    </div>
  );
}

function ScoreControls({ label, score, plus, minus }: { label: string; score: number; plus: () => void; minus: () => void }) {
  return (
    <div className="score-control">
      <div className="score-control-row">
        <h3>{label}</h3>
        <strong>{score}</strong>
      </div>
      <div className="score-control-actions">
        <button className="button primary" type="button" onClick={plus} aria-label={`Add point to ${label}`}><Plus size={16} /> 1</button>
        <button className="button" type="button" onClick={minus} aria-label={`Subtract point from ${label}`}>−1</button>
      </div>
    </div>
  );
}

const labOverlayOrder: SoccerLabOverlay[] = [
  "full-matchup",
  "lower-matchup",
  "lower-result",
  "lineup-panel",
  "scorebug",
  "countdown-timer",
  "one-line-text",
  "two-line-text"
];

const labOverlayLabels: Record<SoccerLabOverlay, string> = {
  "full-matchup": "Full page matchup",
  "lower-matchup": "Lower matchup",
  "lower-result": "Lower score matchup",
  "lineup-panel": "Lineup panel",
  scorebug: "Scorebug",
  "countdown-timer": "Countdown timer",
  "one-line-text": "1-line text bug",
  "two-line-text": "2-line text bug"
};

function SoccerPackageStylePanel({ state, updatePackage }: { state: SoccerState; updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void }) {
  return (
    <div className="panel">
      <h2>Soccer package</h2>
      <div className="form-grid">
        <label className="field">
          <span>Overlay package</span>
          <select value={state.soccerPackage.overlayPackage} onChange={(event) => updatePackage({ overlayPackage: event.target.value as SoccerState["soccerPackage"]["overlayPackage"] })}>
            <option value="classic">Classic</option>
            <option value="rounded">Rounded</option>
          </select>
        </label>
        <label className="control-row">
          <input type="checkbox" checked={state.soccerPackage.packageBackground} onChange={(event) => updatePackage({ packageBackground: event.target.checked })} />
          Package background
        </label>
        <label className="field">
          <span>Background opacity</span>
          <input type="range" min="0" max="100" value={Math.round(state.soccerPackage.packageBackgroundOpacity * 100)} onChange={(event) => updatePackage({ packageBackgroundOpacity: Number(event.target.value) / 100 })} />
        </label>
      </div>
    </div>
  );
}

function SoccerLabOverlayControls({
  state,
  updatePackage,
  runAction
}: {
  state: SoccerState;
  updatePackage: (patch: Partial<SoccerState["soccerPackage"]>) => void;
  runAction: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}) {
  const selected = state.soccerPackage.selectedOverlay;

  function takeOverlay(overlay: SoccerLabOverlay) {
    if (state.soccerPackage.activeOverlay === overlay) {
      void runAction("hide-overlay", { overlay });
      return;
    }
    void runAction("show-overlay", { overlay });
  }

  return (
    <div className="lab-overlay-list">
      <div className="panel-heading">
        <div>
          <h2>Overlays</h2>
        </div>
      </div>
      <div className="overlay-card-grid">
        {labOverlayOrder.map((overlay) => (
          <div
            key={overlay}
            role="button"
            tabIndex={0}
            className={`overlay-control-card ${selected === overlay ? "selected" : ""} ${state.soccerPackage.activeOverlay === overlay ? "active" : ""}`}
            onClick={() => updatePackage({ selectedOverlay: overlay })}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                updatePackage({ selectedOverlay: overlay });
              }
            }}
          >
            <strong>{labOverlayLabels[overlay]}</strong>
            <button
              className={`overlay-card-action ${state.soccerPackage.activeOverlay === overlay ? "is-active" : ""}`}
              type="button"
              aria-label={state.soccerPackage.activeOverlay === overlay ? `Stop ${labOverlayLabels[overlay]}` : `Play ${labOverlayLabels[overlay]}`}
              title={state.soccerPackage.activeOverlay === overlay ? "Stop overlay" : "Play overlay"}
              onClick={(event) => {
                event.stopPropagation();
                takeOverlay(overlay);
              }}
            >
              {state.soccerPackage.activeOverlay === overlay ? <Square size={12} fill="currentColor" strokeWidth={0} /> : <Play size={12} fill="currentColor" strokeWidth={0} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const positionOptions: PositionPreset[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];

function PositionSelect({ value, onChange }: { value: PositionPreset; onChange: (value: PositionPreset) => void }) {
  return (
    <label className="field">
      <span>Position</span>
      <select value={value} onChange={(event) => onChange(event.target.value as PositionPreset)}>
        {positionOptions.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  );
}

function TeamLogo({ team }: { team: SoccerState["home"] }) {
  return team.logoUrl ? (
    <img className="team-library-logo" src={mediaApi.mediaUrl(team.logoUrl)} alt="" />
  ) : (
    <span className="team-library-logo fallback">{(team.abbreviation || team.shortName || "?").slice(0, 2)}</span>
  );
}

function TeamAssignmentCard({
  side,
  team,
  teams,
  onSelect,
  onClear,
  onRefresh
}: {
  side: "home" | "away";
  team: SoccerState["home"];
  teams: TeamLibraryEntry[];
  onSelect: (teamId: string) => void;
  onClear: () => void;
  onRefresh: () => void;
}) {
  const match = findSavedTeamMatch(team, teams);
  return (
    <section className="assignment-card" style={{ "--team-primary": team.primaryColor, "--team-secondary": team.secondaryColor } as React.CSSProperties}>
      <div className="assignment-card-header">
        <TeamLogo team={team} />
        <span>
          <small>{side}</small>
          <strong>{team.fullName}</strong>
          <em>{team.abbreviation} · {formatRecord(team.record)} · {team.roster.length} roster</em>
        </span>
      </div>
      <label className="field">
        <span>Assign saved team</span>
        <select value="" onChange={(event) => onSelect(event.target.value)}>
          <option value="">Select saved team</option>
          {teams.map((item) => <option key={item.id} value={item.id}>{item.fullName}</option>)}
        </select>
      </label>
      <div className="control-row">
        <button className="button" type="button" onClick={onRefresh} disabled={!match}>Refresh from saved</button>
        <button className="button" type="button" onClick={onClear}>Clear team</button>
      </div>
      <p className="muted">{match ? `Snapshot from ${match.fullName}.` : "No saved team match for refresh."}</p>
    </section>
  );
}

function TeamFields({
  team,
  media,
  onChange
}: {
  team: SoccerState["home"];
  media: MediaItem[];
  onChange: (patch: Partial<SoccerState["home"]>) => void;
}) {
  const record = team.record || { wins: 0, losses: 0, draws: 0 };
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function uploadLogo(files: FileList | File[]) {
    const file = Array.from(files)[0];
    if (!file) return;
    setUploadingLogo(true);
    setLogoError(null);
    try {
      const response = await mediaApi.upload(file);
      onChange({ logoMediaId: response.media.id, logoUrl: response.media.url });
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Logo upload failed");
    } finally {
      setUploadingLogo(false);
    }
  }

  return (
    <div className="form-grid">
      <div className="two-col">
        <label className="field"><span>Team name</span><input value={titleCaseFirst(team.fullName)} onChange={(e) => onChange({ fullName: titleCaseFirst(e.target.value) })} /></label>
        <label className="field"><span>Abbreviation</span><input value={team.abbreviation} onChange={(e) => onChange({ abbreviation: e.target.value.toUpperCase().slice(0, 5), shortName: e.target.value.toUpperCase().slice(0, 5) })} /></label>
      </div>
      <div className="record-color-row">
        <label className="field">
          <span>Record (W-L-T)</span>
          <input
            value={`${record.wins}-${record.losses}-${record.draws}`}
            onChange={(e) => onChange({ record: parseRecordValue(e.target.value, record) })}
            placeholder="0-0-0"
          />
        </label>
        <div className="color-swatch-group" aria-label="Team colors">
          <label className="field color-swatch-field"><span>Primary</span><input type="color" value={team.primaryColor} onChange={(e) => onChange({ primaryColor: e.target.value })} /></label>
          <label className="field color-swatch-field"><span>Secondary</span><input type="color" value={team.secondaryColor} onChange={(e) => onChange({ secondaryColor: e.target.value })} /></label>
        </div>
      </div>
      <div className="field">
        <span>Logo</span>
        <label
          className="logo-upload-target"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void uploadLogo(event.dataTransfer.files);
          }}
        >
          {team.logoUrl ? <img src={mediaApi.mediaUrl(team.logoUrl)} alt="" /> : <Upload size={20} />}
          <strong>{uploadingLogo ? "Uploading..." : "Upload logo"}</strong>
          <small>{team.logoUrl ? "Drop or click to replace" : "Drop image here or click"}</small>
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            hidden
            onChange={(event) => event.target.files && void uploadLogo(event.target.files)}
          />
        </label>
        {logoError ? <p className="field-error">{logoError}</p> : null}
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
      </div>
      <div className="image-crop-controls">
        <div className="panel-heading compact">
          <h3>Image crop</h3>
          <p className="muted">Applied anywhere this team image replaces a flag.</p>
        </div>
        <div className="crop-preview" style={{ "--team-primary": team.primaryColor, "--team-secondary": team.secondaryColor } as React.CSSProperties}>
          {team.logoUrl ? (
            <img
              src={mediaApi.mediaUrl(team.logoUrl)}
              alt=""
              style={{
                transform: `translate(${team.imageCrop.x}px, ${team.imageCrop.y}px) scale(${team.imageCrop.zoom})`
              }}
            />
          ) : (
            <span>{(team.abbreviation || team.shortName || "?").slice(0, 2)}</span>
          )}
        </div>
        <div className="three-col">
          <NumberField label="X" value={team.imageCrop.x} onChange={(value) => onChange({ imageCrop: { ...team.imageCrop, x: value } })} />
          <NumberField label="Y" value={team.imageCrop.y} onChange={(value) => onChange({ imageCrop: { ...team.imageCrop, y: value } })} />
          <label className="field">
            <span>Zoom</span>
            <input type="number" min="0.25" step="0.05" value={team.imageCrop.zoom} onChange={(event) => onChange({ imageCrop: { ...team.imageCrop, zoom: Math.max(0.25, Number(event.target.value)) } })} />
          </label>
        </div>
      </div>
      <label className="field">
        <span>Roster</span>
        <textarea className="roster-textarea" value={team.rosterText} onChange={(e) => onChange({ rosterText: e.target.value })} placeholder="10 Max Grenham" />
      </label>
      <label className="field"><span>Coach</span><input value={team.coach} onChange={(e) => onChange({ coach: e.target.value })} /></label>
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
      <TeamFields team={team} media={media} onChange={onChange} />
      <p className="muted" style={{ marginTop: 10 }}>{side === "home" ? "Home" : "Away"} roster lines are parsed into lineup entries automatically.</p>
    </div>
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

function mergeTeamPatch<T extends SoccerState["home"]>(team: T, patch: Partial<SoccerState["home"]>): T {
  const rosterText = patch.rosterText ?? team.rosterText;
  return {
    ...team,
    ...patch,
    roster: patch.rosterText !== undefined ? parseRoster(rosterText) : patch.roster ?? team.roster,
    record: patch.record ? { ...(team.record || { wins: 0, losses: 0, draws: 0 }), ...patch.record } : team.record
  };
}

function makeAbbreviation(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "TEAM";
}

function findSavedTeamMatch(team: SoccerState["home"], teams: TeamLibraryEntry[]): TeamLibraryEntry | undefined {
  return teams.find((candidate) => candidate.fullName === team.fullName || candidate.abbreviation === team.abbreviation);
}

function dateTimeLocalValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function titleCaseFirst(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed[0].toUpperCase()}${trimmed.slice(1)}` : trimmed;
}

function saveStatusLabel(status: "idle" | "saving" | "saved" | "error", updatedAt: string): string {
  if (status === "saving") return "Autosaving...";
  if (status === "saved") return "Saved";
  if (status === "error") return "Autosave failed";
  return `Updated ${new Date(updatedAt).toLocaleDateString()}`;
}

function formatRecord(record?: SoccerState["home"]["record"]): string {
  const value = record || { wins: 0, losses: 0, draws: 0 };
  return `${value.wins}-${value.losses}-${value.draws}`;
}

function soccerTeamTextFields(side: "home" | "away", state: SoccerState): SoccerTextAnimationField[] {
  const fields: SoccerTextAnimationField[] = side === "home"
    ? ["home-name", "home-abbrev", "home-record", "home-logo"]
    : ["away-name", "away-abbrev", "away-record", "away-logo"];
  if (state.soccerPackage.lineupTeam === side) fields.push("lineup-title", "lineup-logo", "lineup-rows");
  return fields;
}

function soccerTextFieldIsVisible(field: SoccerTextAnimationField, overlay: SoccerLabOverlay | null, state: SoccerState | null): boolean {
  if (!overlay || !state) return false;
  switch (overlay) {
    case "full-matchup":
      return ["event-title", "production-name", "home-name", "away-name", "home-record", "away-record", "home-logo", "away-logo"].includes(field);
    case "lower-matchup":
      return ["event-title", "home-name", "away-name", "home-record", "away-record", "home-logo", "away-logo"].includes(field);
    case "lower-result":
      return ["event-title", "home-abbrev", "away-abbrev", "home-logo", "away-logo"].includes(field);
    case "lineup-panel":
      return ["lineup-title", "lineup-logo", "lineup-rows"].includes(field);
    case "scorebug":
      return ["home-abbrev", "away-abbrev"].includes(field);
    case "one-line-text":
      return field === "one-line";
    case "two-line-text":
      return field === "two-line-a" || field === "two-line-b";
    case "countdown-timer":
      return false;
  }
}

function uniqueSoccerTextFields(fields: SoccerTextAnimationField[]): SoccerTextAnimationField[] {
  return Array.from(new Set(fields));
}

function parseRecordValue(value: string, fallback: SoccerState["home"]["record"]): SoccerState["home"]["record"] {
  const [wins, losses, draws] = value
    .split(/[/-]/)
    .map((part) => Number.parseInt(part.trim(), 10));
  return {
    wins: Number.isFinite(wins) ? Math.max(0, wins) : fallback.wins,
    losses: Number.isFinite(losses) ? Math.max(0, losses) : fallback.losses,
    draws: Number.isFinite(draws) ? Math.max(0, draws) : fallback.draws
  };
}

function teamLibraryToSoccerTeam(team: TeamLibraryEntry): SoccerState["home"] {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...soccerTeam } = team;
  return soccerTeam;
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
    document.body.classList.add("overlay-route-body");
    return () => document.body.classList.remove("overlay-route-body");
  }, []);

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
