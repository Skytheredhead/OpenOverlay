import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import {
  AlertTriangle,
  Check,
  Copy,
  Image,
  LayoutDashboard,
  Github,
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
  OPENOVERLAY_API_VERSION,
  OPENOVERLAY_REALTIME_VERSION,
  computeClockSeconds,
  createDefaultChurchState,
  createDefaultSoccerState,
  defaultTeamColors,
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
import { FRONTEND_BUILD, WS_URL, authApi, mediaApi, overlayApi, presetApi, statusApi, teamApi, type BuildInfo, type MediaItem, type User } from "./lib/api";
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
type DeploymentCheckResult =
  | { status: "idle" | "ok" }
  | { status: "mismatch"; frontend: BuildInfo; backend: BuildInfo }
  | { status: "unknown"; reason: string }
  | { status: "error"; reason: string };

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
const SIDEBAR_MIN_WIDTH = 232;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_DEFAULT_WIDTH = 232;
const DEPLOYMENT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TEAM_COLOR_PAIRS = [
  defaultTeamColors.home,
  defaultTeamColors.away
];
const PRESET_NAME_PLACEHOLDERS: Record<PresetType, string> = {
  soccer: "Soccer Game",
  church: "Church Sunday",
  custom: "Custom"
};

export function App() {
  return (
    <ThemeProvider>
      <PromptDialogProvider>
        <AuthProvider>
          <DeploymentCompatibilityChecker />
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

function DeploymentCompatibilityChecker() {
  const location = useLocation();
  const [result, setResult] = useState<DeploymentCheckResult>({ status: "idle" });
  const isOverlayOutput = location.pathname.startsWith("/overlay/");

  useEffect(() => {
    if (isOverlayOutput) return;

    const controller = new AbortController();
    let timeoutId: number | undefined;

    async function check() {
      try {
        const health = await statusApi.health(controller.signal);
        if (controller.signal.aborted) return;
        const backendBuild = health.build;
        const supportsFrontendApi = health.compatibility?.api?.supported.includes(FRONTEND_BUILD.requiredApiVersion);
        const supportsFrontendRealtime = health.compatibility?.realtime?.supported.includes(FRONTEND_BUILD.requiredRealtimeVersion);

        if (supportsFrontendApi === false || supportsFrontendRealtime === false) {
          setResult({ status: "error", reason: `Backend does not support required API/realtime version ${FRONTEND_BUILD.requiredApiVersion}/${FRONTEND_BUILD.requiredRealtimeVersion}.` });
          return;
        }

        if (FRONTEND_BUILD.commit && backendBuild?.commit) {
          setResult(FRONTEND_BUILD.commit === backendBuild.commit ? { status: "ok" } : { status: "mismatch", frontend: FRONTEND_BUILD, backend: backendBuild });
          return;
        }

        if (import.meta.env.PROD) {
          const missing = [FRONTEND_BUILD.commit ? null : "frontend", backendBuild?.commit ? null : "backend"].filter(Boolean).join(" and ");
          setResult({ status: "unknown", reason: `Missing ${missing} build metadata.` });
        } else {
          setResult({ status: "ok" });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setResult({ status: "error", reason: error instanceof Error ? error.message : "Could not reach backend health." });
      } finally {
        if (!controller.signal.aborted) {
          timeoutId = window.setTimeout(check, DEPLOYMENT_CHECK_INTERVAL_MS);
        }
      }
    }

    void check();

    return () => {
      controller.abort();
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isOverlayOutput]);

  if (isOverlayOutput) return null;

  let message: string;
  let tone: "warn" | "neutral";

  switch (result.status) {
    case "mismatch":
      message = `Frontend build ${formatBuildLabel(result.frontend)} and backend build ${formatBuildLabel(result.backend)} differ. Redeploy the stale side before going live.`;
      tone = "warn";
      break;
    case "unknown":
      message = `Deployment sync check incomplete. ${result.reason}`;
      tone = "neutral";
      break;
    case "error":
      message = `Deployment sync check failed. ${result.reason}`;
      tone = "neutral";
      break;
    default:
      return null;
  }

  return (
    <div className={`deployment-check-banner ${tone}`} role={result.status === "mismatch" ? "alert" : "status"}>
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function formatBuildLabel(build: BuildInfo): string {
  return build.commitShort || build.commit?.slice(0, 7) || build.version || "unknown";
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
          <p>Free and open-source livestream graphics.</p>
          <div className="hero-actions">
            <Link className="button primary" to="/signup">Create account</Link>
            <Link className="button" to="/login">Login</Link>
          </div>
        </section>
        <section className="hero-preview" aria-label="Overlay preview">
          <OverlayRenderer type="soccer" state={demoSoccerState()} transparent={false} />
        </section>
      </main>
      <footer className="home-footer">
        <a
          className="home-footer-link"
          href="https://github.com/Skytheredhead/OpenOverlay"
          target="_blank"
          rel="noreferrer"
          aria-label="OpenOverlay GitHub repository"
        >
          <Github size={18} />
          <span>OpenOverlay</span>
        </a>
      </footer>
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
        <div className="sidebar-nav-wrap" aria-hidden={sidebarCollapsed}>
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
          <nav className="sidebar-nav">
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
        </div>
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

function formatOverlayClientCount(count: number): string {
  return `${count} ${count === 1 ? "client" : "clients"}`;
}

function Dashboard() {
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isNewGameOpen, setIsNewGameOpen] = useState(false);
  const [newGameType, setNewGameType] = useState<PresetType>("soccer");
  const [newGameName, setNewGameName] = useState(PRESET_NAME_PLACEHOLDERS.soccer);
  const navigate = useNavigate();
  const newGameNameRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const response = await presetApi.list();
    setPresets(response.presets);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [load]);

  useEffect(() => {
    if (!isNewGameOpen) return;
    const id = window.setTimeout(() => newGameNameRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [isNewGameOpen]);

  function openNewGameDialog() {
    setNewGameType("soccer");
    setNewGameName(PRESET_NAME_PLACEHOLDERS.soccer);
    setIsNewGameOpen(true);
  }

  function closeNewGameDialog() {
    setIsNewGameOpen(false);
  }

  async function createPreset(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = newGameName.trim();
    if (!trimmedName) return;
    setError(null);
    try {
      const response = await presetApi.create(trimmedName, newGameType);
      setIsNewGameOpen(false);
      navigate(`/dash/presets/${response.preset.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create game");
    }
  }

  async function copyGameOverlayLink(publicId: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/overlay/${publicId}`);
      setError(null);
    } catch {
      setError("Could not copy overlay URL.");
    }
  }

  return (
    <>
      <div className="page-title">
        <h1>Games</h1>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <section className="preset-grid game-card-grid">
        <button className="preset-card preset-card-new" type="button" onClick={openNewGameDialog}>
          <span className="new-game-card-icon" aria-hidden="true"><Plus size={22} /></span>
          <span className="new-game-card-copy">
            <h2>New Game</h2>
            <p>Soccer / Church / Custom</p>
          </span>
        </button>
        {presets.map((preset) => (
          <article className="preset-card game-card" key={preset.id}>
            <div className="game-card-body">
              <div className="game-card-meta">
                <span>{preset.type === "soccer" ? "Soccer" : preset.type}</span>
                <span>{formatOverlayClientCount(preset.overlayClientCount || 0)}</span>
              </div>
              <h2>{preset.name}</h2>
              <div className="control-row game-card-actions">
                <button className="button game-card-copy" type="button" onClick={() => void copyGameOverlayLink(preset.publicId)}><Copy size={14} /> Copy overlay</button>
              </div>
            </div>
            <Link className="button game-card-play" to={`/dash/presets/${preset.id}`} aria-label={`Open ${preset.name}`} title={`Open ${preset.name}`}>
              <Play size={40} fill="currentColor" strokeWidth={0} />
            </Link>
          </article>
        ))}
      </section>
      {isNewGameOpen ? (
        <div className="prompt-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeNewGameDialog();
        }}>
          <form
            className="prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-game-dialog-title"
            onSubmit={createPreset}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeNewGameDialog();
            }}
          >
            <h2 id="new-game-dialog-title">New game</h2>
            <label className="field">
              <span>Game type</span>
              <select
                className="number-input"
                value={newGameType}
                onChange={(event) => {
                  const nextType = event.target.value as PresetType;
                  setNewGameType(nextType);
                  setNewGameName(PRESET_NAME_PLACEHOLDERS[nextType]);
                }}
              >
                <option value="soccer">Soccer</option>
                <option value="church">Church</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className="field">
              <span>Game name</span>
              <input
                ref={newGameNameRef}
                value={newGameName}
                onChange={(event) => setNewGameName(event.target.value)}
                placeholder={PRESET_NAME_PLACEHOLDERS[newGameType]}
              />
            </label>
            <div className="control-row prompt-actions">
              <button className="button" type="button" onClick={closeNewGameDialog}>Cancel</button>
              <button className="button primary" type="submit">Create game</button>
            </div>
          </form>
        </div>
      ) : null}
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
  const selectedTeamIdRef = useRef<string | null>(null);
  const teamSaveRevisionRef = useRef(0);
  const latestTeamSaveRevisionRef = useRef<Record<string, number>>({});
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
    selectedTeamIdRef.current = selectedId;
    setDraft((current) => {
      if (!selectedId) return null;
      if (current?.id === selectedId) return current;
      const selected = teams.find((team) => team.id === selectedId) || null;
      return selected ? structuredClone(selected) : null;
    });
  }, [selectedId, teams]);

  const debouncedSaveTeam = useDebouncedCallback((team: TeamLibraryEntry, revision: number) => {
    setSaveStatus("saving");
    void teamApi.patch(team.id, team).then((response) => {
      if (latestTeamSaveRevisionRef.current[response.team.id] !== revision) return;
      setTeams((current) => current.map((item) => (item.id === response.team.id ? response.team : item)));
      setDraft((current) => (current?.id === response.team.id ? { ...current, updatedAt: response.team.updatedAt } : current));
      if (selectedTeamIdRef.current === response.team.id) setSaveStatus("saved");
    }).catch((err) => {
      if (latestTeamSaveRevisionRef.current[team.id] !== revision) return;
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
      const revision = teamSaveRevisionRef.current + 1;
      teamSaveRevisionRef.current = revision;
      latestTeamSaveRevisionRef.current[next.id] = revision;
      setSaveStatus("saving");
      debouncedSaveTeam(next, revision);
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
    <div className="teams-page">
      <div className="page-title">
        <h1>Teams</h1>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className={`team-library-layout ${draft ? "" : "empty"}`}>
        <section className="team-list">
          <button
            type="button"
            className="team-list-item team-list-item-new"
            style={{
              "--team-primary": "var(--sw-red)",
              "--team-secondary": "color-mix(in srgb, var(--sw-bg) 82%, white 18%)"
            } as React.CSSProperties}
            onClick={() => void createTeam()}
          >
            <span className="team-list-item-icon" aria-hidden="true">
              <Plus size={20} />
            </span>
            <strong>New Team</strong>
          </button>
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
    </div>
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
  const [showConnectionWarning, setShowConnectionWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<PresetState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pendingSoccerTextUpdate, setPendingSoccerTextUpdate] = useState<{ state: SoccerState; fields: SoccerTextAnimationField[] } | null>(null);
  const latestPresetSaveRevisionRef = useRef(0);
  const hasPendingPresetSaveRef = useRef(false);
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
      auth: { role: "admin", presetId, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION },
      query: { role: "admin", presetId, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION }
    });
    socketRef.current = socket;
    socket.on("connect", () => setConnection("connected"));
    socket.on("disconnect", () => setConnection("disconnected"));
    socket.on("connect_error", () => setConnection("disconnected"));
    socket.on("preset:update", (payload: PresetSummary) => {
      setPreset((current) => {
        if (hasPendingPresetSaveRef.current && current?.id === payload.id) {
          return { ...payload, state: current.state };
        }
        return payload;
      });
    });
    socket.on("overlay:clients", (payload: { count: number }) => {
      setPreset((current) => (current ? { ...current, overlayClientCount: payload.count } : current));
    });
    return () => {
      socket.disconnect();
    };
  }, [presetId]);

  useEffect(() => {
    if (connection !== "disconnected") {
      setShowConnectionWarning(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowConnectionWarning(true), 3000);
    return () => window.clearTimeout(timeout);
  }, [connection]);

  const debouncedPersist = useDebouncedCallback((nextState: PresetState, revision: number) => {
    if (!presetId) return;
    void presetApi.patch(presetId, { state: nextState }).then((response) => {
      if (latestPresetSaveRevisionRef.current !== revision) return;
      hasPendingPresetSaveRef.current = false;
      setPreset((current) => (current?.id === response.preset.id ? { ...response.preset, state: current.state } : response.preset));
    }).catch((err) => {
      if (latestPresetSaveRevisionRef.current !== revision) return;
      hasPendingPresetSaveRef.current = false;
      setError(err.message);
    });
  }, 180);

  const commitState = useCallback((nextState: PresetState, persist = true) => {
    setPreset((current) => (current ? { ...current, state: nextState } : current));
    setHistory((current) => {
      const trimmed = current.slice(0, historyIndex + 1);
      return [...trimmed, structuredClone(nextState)].slice(-60);
    });
    setHistoryIndex((index) => Math.min(index + 1, 59));
    if (persist) {
      const revision = latestPresetSaveRevisionRef.current + 1;
      latestPresetSaveRevisionRef.current = revision;
      hasPendingPresetSaveRef.current = true;
      debouncedPersist(nextState, revision);
    }
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

  if (!preset) return <div className="live-game-page">Loading game...</div>;
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
    <div className="live-game-page">
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

      {showConnectionWarning ? <div className="error">Backend or overlay WebSocket is disconnected. The overlay will keep showing its last known state.</div> : null}
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
    </div>
  );
}

function OutputPreviewFrame({ src, title, surface }: { src: string; title: string; surface: SoccerState["soccerPackage"]["surface"] }) {
  return (
    <div className={`preview-frame preview-surface-${surface}`}>
      <iframe
        className="output-preview-iframe"
        src={previewOverlaySrc(src)}
        title={title}
        loading="eager"
      />
    </div>
  );
}

function previewOverlaySrc(src: string): string {
  const url = new URL(src, window.location.origin);
  url.searchParams.set("client", "preview");
  return url.toString();
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

  function startPresetCountdown(seconds: number) {
    updatePackage({
      activeOverlay: "countdown-timer",
      selectedOverlay: "countdown-timer",
      countdown: {
        ...state.soccerPackage.countdown,
        seconds,
        resetSeconds: seconds,
        running: true,
        startedAtMs: Date.now()
      }
    });
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
          <button className="button" type="button" onClick={() => startPresetCountdown(300)}>5:00</button>
          <button className="button" type="button" onClick={() => startPresetCountdown(600)}>10:00</button>
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
        <label className="field">
          <span>Countdown label</span>
          <input value={state.soccerPackage.countdown.label} onChange={(event) => updateCountdown({ label: event.target.value })} />
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
          <div className={`clock-toggle-option ${state.clock.stopAtEnabled ? "" : "is-disabled"}`}>
            <div className="clock-toggle-inline">
              <label className="custom-checkbox-control" aria-label="Enable stop at">
                <input type="checkbox" checked={state.clock.stopAtEnabled} onChange={(event) => updateClock({ stopAtEnabled: event.target.checked })} />
                <span className="custom-checkbox-glyph" aria-hidden="true"><Check size={10} /></span>
              </label>
              <label className="field">
                <span>Stop at</span>
                <input defaultValue={formatClock(state.clock.stopAtSeconds)} disabled={!state.clock.stopAtEnabled} onBlur={(event) => updateClock({ stopAtSeconds: parseClockTime(event.target.value) })} />
              </label>
            </div>
          </div>
          <div className={`clock-toggle-option ${state.clock.showStoppage ? "" : "is-disabled"}`}>
            <div className="clock-toggle-inline">
              <label className="custom-checkbox-control" aria-label="Enable stoppage time">
                <input type="checkbox" checked={state.clock.showStoppage} onChange={(event) => updateClock({ showStoppage: event.target.checked })} />
                <span className="custom-checkbox-glyph" aria-hidden="true"><Check size={10} /></span>
              </label>
              <label className="field">
                <span>Stoppage minutes</span>
                <input type="number" min="0" value={state.clock.stoppageMinutes} disabled={!state.clock.showStoppage} onChange={(event) => updateClock({ stoppageMinutes: Math.max(0, Number(event.target.value)) })} />
              </label>
            </div>
          </div>
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
  const latestTeamRef = useRef(team);
  const colorsEditedRef = useRef(false);
  const teamIdentity = (team as Partial<TeamLibraryEntry>).id ?? null;

  useEffect(() => {
    latestTeamRef.current = team;
  }, [team]);

  useEffect(() => {
    colorsEditedRef.current = false;
  }, [teamIdentity]);

  async function uploadLogo(files: FileList | File[]) {
    const file = Array.from(files)[0];
    if (!file) return;
    setUploadingLogo(true);
    setLogoError(null);
    try {
      const shouldExtractColors = !colorsEditedRef.current && shouldAutofillTeamColors(latestTeamRef.current);
      const [response, extractedColors] = await Promise.all([
        mediaApi.upload(file),
        shouldExtractColors ? extractLogoColors(file).catch(() => null) : Promise.resolve(null)
      ]);
      const patch: Partial<SoccerState["home"]> = { logoMediaId: response.media.id, logoUrl: response.media.url };
      if (extractedColors && !colorsEditedRef.current && shouldAutofillTeamColors(latestTeamRef.current)) {
        patch.primaryColor = extractedColors.primaryColor;
        patch.secondaryColor = extractedColors.secondaryColor;
      }
      onChange(patch);
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
          <label className="field color-swatch-field"><span>Primary</span><input type="color" value={team.primaryColor} onChange={(e) => { colorsEditedRef.current = true; onChange({ primaryColor: e.target.value }); }} /></label>
          <label className="field color-swatch-field"><span>Secondary</span><input type="color" value={team.secondaryColor} onChange={(e) => { colorsEditedRef.current = true; onChange({ secondaryColor: e.target.value }); }} /></label>
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
            onChange({ logoMediaId: selected?.id ?? "", logoUrl: selected?.url ?? "" });
          }}
        >
          <option value="">No logo</option>
          {media.map((item) => <option key={item.id} value={item.id}>{item.originalFilename}</option>)}
        </select>
      </div>
      <div className="image-crop-controls">
        <div className="panel-heading compact">
          <h3>Image crop</h3>
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

interface LogoColorSample {
  r: number;
  g: number;
  b: number;
  saturation: number;
  lightness: number;
}

interface LogoColorCluster extends LogoColorSample {
  count: number;
  score: number;
}

function shouldAutofillTeamColors(team: Pick<SoccerState["home"], "primaryColor" | "secondaryColor">): boolean {
  return DEFAULT_TEAM_COLOR_PAIRS.some((pair) => {
    return sameHexColor(team.primaryColor, pair.primaryColor) && sameHexColor(team.secondaryColor, pair.secondaryColor);
  });
}

async function extractLogoColors(file: File): Promise<{ primaryColor: string; secondaryColor: string } | null> {
  if (!file.type.startsWith("image/")) return null;
  const image = await loadImageFromFile(file);
  const maxSize = 128;
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const samples: LogoColorSample[] = [];

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 80) continue;
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const { saturation, lightness } = rgbToHsl(r, g, b);
    if (lightness > 0.98 && saturation < 0.08) continue;
    samples.push({ r, g, b, saturation, lightness });
  }

  if (!samples.length) return null;
  const chromaticSamples = samples.filter((sample) => sample.saturation >= 0.18 && sample.lightness > 0.1 && sample.lightness < 0.94);
  const sourceSamples = chromaticSamples.length >= Math.max(12, samples.length * 0.01) ? chromaticSamples : samples;
  const clusters = clusterLogoColors(sourceSamples);
  const primary = clusters[0];
  if (!primary) return null;
  const secondary = clusters.find((cluster) => colorDistance(primary, cluster) >= 54) ?? clusters[1] ?? deriveSecondaryColor(primary);
  return {
    primaryColor: rgbToHex(primary),
    secondaryColor: rgbToHex(secondary)
  };
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read logo image"));
    };
    image.src = url;
  });
}

function clusterLogoColors(samples: LogoColorSample[]): LogoColorCluster[] {
  const buckets = new Map<string, { r: number; g: number; b: number; count: number; score: number; saturation: number; lightness: number }>();
  for (const sample of samples) {
    const key = [quantizeColor(sample.r), quantizeColor(sample.g), quantizeColor(sample.b)].join("-");
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0, score: 0, saturation: 0, lightness: 0 };
    bucket.r += sample.r;
    bucket.g += sample.g;
    bucket.b += sample.b;
    bucket.count += 1;
    bucket.saturation += sample.saturation;
    bucket.lightness += sample.lightness;
    bucket.score += 0.7 + sample.saturation;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count),
      count: bucket.count,
      saturation: bucket.saturation / bucket.count,
      lightness: bucket.lightness / bucket.count,
      score: bucket.score
    }))
    .sort((a, b) => b.score - a.score);
}

function deriveSecondaryColor(color: LogoColorSample): LogoColorSample {
  const { h, saturation, lightness } = rgbToHsl(color.r, color.g, color.b);
  const derivedLightness = lightness > 0.54 ? Math.max(0.18, lightness - 0.34) : Math.min(0.88, lightness + 0.34);
  return hslToRgb(h, Math.max(0.2, saturation * 0.75), derivedLightness);
}

function quantizeColor(value: number): number {
  return Math.round(value / 24) * 24;
}

function sameHexColor(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function colorDistance(left: LogoColorSample, right: LogoColorSample): number {
  const redMean = (left.r + right.r) / 2;
  const red = left.r - right.r;
  const green = left.g - right.g;
  const blue = left.b - right.b;
  return Math.sqrt((2 + redMean / 256) * red * red + 4 * green * green + (2 + (255 - redMean) / 256) * blue * blue);
}

function rgbToHex(color: Pick<LogoColorSample, "r" | "g" | "b">): string {
  return `#${[color.r, color.g, color.b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; saturation: number; lightness: number } {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, saturation: 0, lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;
  if (max === red) h = (green - blue) / delta + (green < blue ? 6 : 0);
  if (max === green) h = (blue - red) / delta + 2;
  if (max === blue) h = (red - green) / delta + 4;
  return { h: h / 6, saturation, lightness };
}

function hslToRgb(h: number, saturation: number, lightness: number): LogoColorSample {
  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return { r: value, g: value, b: value, saturation, lightness };
  }
  const hueToRgb = (p: number, q: number, t: number) => {
    let hue = t;
    if (hue < 0) hue += 1;
    if (hue > 1) hue -= 1;
    if (hue < 1 / 6) return p + (q - p) * 6 * hue;
    if (hue < 1 / 2) return q;
    if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
    return p;
  };
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
    saturation,
    lightness
  };
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
  const [searchParams] = useSearchParams();
  const [overlay, setOverlay] = useState<PresetSummary | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [error, setError] = useState<string | null>(null);
  const client = searchParams.get("client") === "preview" ? "preview" : "overlay";

  useLayoutEffect(() => {
    document.documentElement.classList.add("overlay-route-root");
    document.body.classList.add("overlay-route-body");
    return () => {
      document.documentElement.classList.remove("overlay-route-root");
      document.body.classList.remove("overlay-route-body");
    };
  }, []);

  useEffect(() => {
    if (!overlayId) return;
    void overlayApi.get(overlayId).then((response) => setOverlay(response.overlay)).catch((err) => setError(err.message));
    const socket = io(WS_URL, {
      transports: ["websocket", "polling"],
      auth: { role: "overlay", overlayId, client, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION },
      query: { role: "overlay", overlayId, client, apiVersion: OPENOVERLAY_API_VERSION, realtimeVersion: OPENOVERLAY_REALTIME_VERSION }
    });
    socket.on("connect", () => setConnection("connected"));
    socket.on("disconnect", () => setConnection("disconnected"));
    socket.on("connect_error", () => setConnection("disconnected"));
    socket.on("state:update", (payload: PresetSummary) => setOverlay(payload));
    return () => {
      socket.disconnect();
    };
  }, [client, overlayId]);

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
