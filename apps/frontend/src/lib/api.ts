import { OPENOVERLAY_API_VERSION, OPENOVERLAY_REALTIME_VERSION, openOverlayCompatibility, type PresetState, type PresetSummary, type PresetType, type TeamLibraryEntry } from "@openoverlay/shared";

const DEFAULT_API_HOST = window.location.hostname === "127.0.0.1" ? "http://127.0.0.1:8734" : "http://localhost:8734";
const VERSIONED_API_PREFIX = `/api/${OPENOVERLAY_API_VERSION}`;

export const API_BASE = import.meta.env.VITE_API_BASE_URL || DEFAULT_API_HOST;
export const WS_URL = import.meta.env.VITE_WS_URL || API_BASE.replace(/^http/, "ws");
export const FRONTEND_BUILD = {
  ...__OPENOVERLAY_BUILD_INFO__,
  requiredApiVersion: OPENOVERLAY_API_VERSION,
  requiredRealtimeVersion: OPENOVERLAY_REALTIME_VERSION,
  compatibility: openOverlayCompatibility()
};

export interface BuildInfo {
  version: string | null;
  commit: string | null;
  commitShort: string | null;
  requiredApiVersion?: string;
  requiredRealtimeVersion?: string;
}

export interface HealthResponse {
  ok: true;
  app: string;
  component?: string;
  time: string;
  build?: BuildInfo;
  compatibility?: ReturnType<typeof openOverlayCompatibility>;
}

export interface User {
  id: string;
  email: string;
}

export interface MediaItem {
  id: string;
  publicId: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  createdAt: string;
  url: string;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${versionedApiPath(path)}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-OpenOverlay-Api-Version": OPENOVERLAY_API_VERSION,
      ...(options.headers || {})
    },
    ...options
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(typeof body === "object" && body?.error ? body.error : `Request failed: ${response.status}`);
  }
  return body as T;
}

function versionedApiPath(path: string): string {
  return path.startsWith("/api/") ? `${VERSIONED_API_PREFIX}${path.slice("/api".length)}` : path;
}

export const authApi = {
  signup(email: string, password: string) {
    return api<{ user: User }>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
  },
  login(email: string, password: string) {
    return api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  },
  logout() {
    return api<{ ok: true }>("/api/auth/logout", { method: "POST" });
  },
  me() {
    return api<{ user: User }>("/api/auth/me");
  }
};

export const presetApi = {
  list() {
    return api<{ presets: PresetSummary[] }>("/api/presets");
  },
  create(name: string, type: PresetType) {
    return api<{ preset: PresetSummary }>("/api/presets", { method: "POST", body: JSON.stringify({ name, type }) });
  },
  get(id: string) {
    return api<{ preset: PresetSummary }>(`/api/presets/${id}`);
  },
  patch(id: string, input: { name?: string; state?: PresetState; statePatch?: Partial<PresetState> }) {
    return api<{ preset: PresetSummary }>(`/api/presets/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  remove(id: string) {
    return api<{ ok: true }>(`/api/presets/${id}`, { method: "DELETE" });
  },
  duplicate(id: string) {
    return api<{ preset: PresetSummary }>(`/api/presets/${id}/duplicate`, { method: "POST", body: JSON.stringify({}) });
  },
  share(id: string, email: string) {
    return api<{ preset: PresetSummary }>(`/api/presets/${id}/share`, { method: "POST", body: JSON.stringify({ email }) });
  },
  actionKey(id: string) {
    return api<{ actionKey: string; preset?: PresetSummary }>(`/api/presets/${id}/action-key`, { method: "POST", body: JSON.stringify({}) });
  },
  action(id: string, action: string, payload: Record<string, unknown> = {}) {
    return api<{ preset: PresetSummary }>(`/api/presets/${id}/actions/${action}`, { method: "POST", body: JSON.stringify(payload) });
  }
};

export const overlayApi = {
  get(publicId: string) {
    return api<{ overlay: PresetSummary }>(`/api/overlay/${publicId}`);
  }
};

export const statusApi = {
  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const response = await fetch(`${API_BASE}/health`, {
      cache: "no-store",
      credentials: "include",
      signal
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Health check failed: ${response.status}`);
    return body as HealthResponse;
  }
};

export const teamApi = {
  list() {
    return api<{ teams: TeamLibraryEntry[] }>("/api/teams");
  },
  create(input: Partial<TeamLibraryEntry>) {
    return api<{ team: TeamLibraryEntry }>("/api/teams", { method: "POST", body: JSON.stringify(input) });
  },
  patch(id: string, input: Partial<TeamLibraryEntry>) {
    return api<{ team: TeamLibraryEntry }>(`/api/teams/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  remove(id: string) {
    return api<{ ok: true }>(`/api/teams/${id}`, { method: "DELETE" });
  }
};

export const mediaApi = {
  list() {
    return api<{ media: MediaItem[] }>("/api/media");
  },
  async upload(file: File): Promise<{ media: MediaItem }> {
    const data = new FormData();
    data.append("file", file);
    const response = await fetch(`${API_BASE}${versionedApiPath("/api/media")}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "X-OpenOverlay-Api-Version": OPENOVERLAY_API_VERSION
      },
      body: data
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Upload failed");
    return body;
  },
  remove(id: string) {
    return api<{ ok: true }>(`/api/media/${id}`, { method: "DELETE" });
  },
  mediaUrl(url: string) {
    return url.startsWith("http") ? url : `${API_BASE}${url}`;
  }
};
