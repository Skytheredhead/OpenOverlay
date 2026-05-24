import type { PresetState, PresetSummary, PresetType } from "@openoverlay/shared";

export const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8734";
export const WS_URL = import.meta.env.VITE_WS_URL || API_BASE.replace(/^http/, "ws");

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
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
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

export const mediaApi = {
  list() {
    return api<{ media: MediaItem[] }>("/api/media");
  },
  async upload(file: File): Promise<{ media: MediaItem }> {
    const data = new FormData();
    data.append("file", file);
    const response = await fetch(`${API_BASE}/api/media`, {
      method: "POST",
      credentials: "include",
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
