import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { PresetState, PresetType, TeamLibraryEntry } from "@openoverlay/shared";
import type { AppConfig } from "./config.js";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  session_version: number;
  created_at: string;
}

export interface PresetRow {
  id: string;
  public_id: string;
  owner_user_id: string;
  name: string;
  type: PresetType;
  state_json: string;
  action_key_hash: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export class RevisionConflictError extends Error {
  constructor(public readonly currentRevision: number) {
    super("Resource was changed by another client");
    this.name = "RevisionConflictError";
  }
}

export interface MediaRow {
  id: string;
  public_id: string;
  owner_user_id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  path: string;
  created_at: string;
}

export interface TeamRow {
  id: string;
  owner_user_id: string;
  team_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface EventLogRow {
  id: string;
  preset_id: string;
  owner_user_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

const MAX_EVENT_LOGS_PER_PRESET = 1_000;
const MAX_EVENT_PAYLOAD_BYTES = 4 * 1024;
const CURRENT_SCHEMA_VERSION = 2;

export class Database {
  private readonly db: DatabaseSync;

  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    fs.mkdirSync(config.uploadDir, { recursive: true });
    this.db = new DatabaseSync(config.databasePath);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  run(sql: string, params: unknown[] = []) {
    return this.db.prepare(sql).run(...(params as never[]));
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  healthCheck(): boolean {
    return this.get<{ ok: number }>("SELECT 1 AS ok")?.ok === 1;
  }

  createUser(email: string, passwordHash: string): UserRow {
    const now = new Date().toISOString();
    const row: UserRow = {
      id: randomUUID(),
      email: email.toLowerCase(),
      password_hash: passwordHash,
      session_version: 1,
      created_at: now
    };
    this.run("INSERT INTO users (id, email, password_hash, session_version, created_at) VALUES (?, ?, ?, ?, ?)", [
      row.id,
      row.email,
      row.password_hash,
      row.session_version,
      row.created_at
    ]);
    return row;
  }

  findUserByEmail(email: string): UserRow | undefined {
    return this.get<UserRow>("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
  }

  findUserById(id: string): UserRow | undefined {
    return this.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  }

  revokeUserSessions(id: string): void {
    this.run("UPDATE users SET session_version = session_version + 1 WHERE id = ?", [id]);
  }

  createPreset(input: {
    ownerUserId: string;
    name: string;
    type: PresetType;
    state: PresetState;
    actionKeyHash?: string | null;
  }): PresetRow {
    const now = new Date().toISOString();
    const row: PresetRow = {
      id: randomUUID(),
      public_id: makePublicId(),
      owner_user_id: input.ownerUserId,
      name: input.name,
      type: input.type,
      state_json: JSON.stringify(input.state),
      action_key_hash: input.actionKeyHash || null,
      revision: 1,
      created_at: now,
      updated_at: now
    };
    this.run(
      "INSERT INTO presets (id, public_id, owner_user_id, name, type, state_json, action_key_hash, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [row.id, row.public_id, row.owner_user_id, row.name, row.type, row.state_json, row.action_key_hash, row.revision, row.created_at, row.updated_at]
    );
    return row;
  }

  listPresetsForUser(ownerUserId: string): PresetRow[] {
    return this.all<PresetRow>("SELECT * FROM presets WHERE owner_user_id = ? ORDER BY updated_at DESC", [ownerUserId]);
  }

  countPresetsForUser(ownerUserId: string): number {
    return Number(this.get<{ count: number }>("SELECT COUNT(*) AS count FROM presets WHERE owner_user_id = ?", [ownerUserId])?.count || 0);
  }

  getPresetForUser(id: string, ownerUserId: string): PresetRow | undefined {
    return this.get<PresetRow>("SELECT * FROM presets WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
  }

  getPresetById(id: string): PresetRow | undefined {
    return this.get<PresetRow>("SELECT * FROM presets WHERE id = ?", [id]);
  }

  getPresetByPublicId(publicId: string): PresetRow | undefined {
    return this.get<PresetRow>("SELECT * FROM presets WHERE public_id = ?", [publicId]);
  }

  updatePreset(input: {
    id: string;
    ownerUserId: string;
    name?: string;
    state?: PresetState;
    actionKeyHash?: string | null;
    expectedRevision?: number;
  }): PresetRow | undefined {
    const existing = this.getPresetForUser(input.id, input.ownerUserId);
    if (!existing) return undefined;
    const expectedRevision = input.expectedRevision ?? existing.revision;
    if (expectedRevision !== existing.revision) {
      throw new RevisionConflictError(existing.revision);
    }
    const next: PresetRow = {
      ...existing,
      name: input.name ?? existing.name,
      state_json: input.state ? JSON.stringify(input.state) : existing.state_json,
      action_key_hash: input.actionKeyHash === undefined ? existing.action_key_hash : input.actionKeyHash,
      revision: existing.revision + 1,
      updated_at: new Date().toISOString()
    };
    const result = this.run(
      "UPDATE presets SET name = ?, state_json = ?, action_key_hash = ?, revision = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND revision = ?",
      [next.name, next.state_json, next.action_key_hash, next.revision, next.updated_at, input.id, input.ownerUserId, expectedRevision]
    );
    if (result.changes === 0) {
      const current = this.getPresetForUser(input.id, input.ownerUserId);
      if (!current) return undefined;
      throw new RevisionConflictError(current.revision);
    }
    return next;
  }

  deletePreset(id: string, ownerUserId: string, expectedRevision: number): PresetRow | undefined {
    const existing = this.getPresetForUser(id, ownerUserId);
    if (!existing) return undefined;
    if (existing.revision !== expectedRevision) throw new RevisionConflictError(existing.revision);
    const result = this.run("DELETE FROM presets WHERE id = ? AND owner_user_id = ? AND revision = ?", [id, ownerUserId, expectedRevision]);
    if (result.changes === 0) {
      const current = this.getPresetForUser(id, ownerUserId);
      if (!current) return undefined;
      throw new RevisionConflictError(current.revision);
    }
    return existing;
  }

  createTeam(input: { ownerUserId: string; team: Omit<TeamLibraryEntry, "id" | "revision" | "createdAt" | "updatedAt"> }): TeamRow {
    const now = new Date().toISOString();
    const id = randomUUID();
    const team: TeamLibraryEntry = {
      ...input.team,
      id,
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    const row: TeamRow = {
      id,
      owner_user_id: input.ownerUserId,
      team_json: JSON.stringify(team),
      revision: 1,
      created_at: now,
      updated_at: now
    };
    this.run("INSERT INTO teams (id, owner_user_id, team_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      row.id,
      row.owner_user_id,
      row.team_json,
      row.revision,
      row.created_at,
      row.updated_at
    ]);
    return row;
  }

  listTeamsForUser(ownerUserId: string): TeamRow[] {
    return this.all<TeamRow>("SELECT * FROM teams WHERE owner_user_id = ? ORDER BY updated_at DESC", [ownerUserId]);
  }

  countTeamsForUser(ownerUserId: string): number {
    return Number(this.get<{ count: number }>("SELECT COUNT(*) AS count FROM teams WHERE owner_user_id = ?", [ownerUserId])?.count || 0);
  }

  getTeamForUser(id: string, ownerUserId: string): TeamRow | undefined {
    return this.get<TeamRow>("SELECT * FROM teams WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
  }

  updateTeam(input: { id: string; ownerUserId: string; team: TeamLibraryEntry; expectedRevision?: number }): TeamRow | undefined {
    const existing = this.getTeamForUser(input.id, input.ownerUserId);
    if (!existing) return undefined;
    const expectedRevision = input.expectedRevision ?? existing.revision;
    if (expectedRevision !== existing.revision) throw new RevisionConflictError(existing.revision);
    const now = new Date().toISOString();
    const team: TeamLibraryEntry = { ...input.team, id: existing.id, revision: existing.revision + 1, createdAt: existing.created_at, updatedAt: now };
    const row: TeamRow = {
      ...existing,
      team_json: JSON.stringify(team),
      revision: existing.revision + 1,
      updated_at: now
    };
    const result = this.run("UPDATE teams SET team_json = ?, revision = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND revision = ?", [
      row.team_json,
      row.revision,
      row.updated_at,
      input.id,
      input.ownerUserId,
      expectedRevision
    ]);
    if (result.changes === 0) {
      const current = this.getTeamForUser(input.id, input.ownerUserId);
      if (!current) return undefined;
      throw new RevisionConflictError(current.revision);
    }
    return row;
  }

  deleteTeam(id: string, ownerUserId: string, expectedRevision: number): TeamRow | undefined {
    const existing = this.getTeamForUser(id, ownerUserId);
    if (!existing) return undefined;
    if (existing.revision !== expectedRevision) throw new RevisionConflictError(existing.revision);
    const result = this.run("DELETE FROM teams WHERE id = ? AND owner_user_id = ? AND revision = ?", [id, ownerUserId, expectedRevision]);
    if (result.changes === 0) {
      const current = this.getTeamForUser(id, ownerUserId);
      if (!current) return undefined;
      throw new RevisionConflictError(current.revision);
    }
    return existing;
  }

  createMedia(input: {
    ownerUserId: string;
    filename: string;
    originalFilename: string;
    mimeType: string;
    width?: number | null;
    height?: number | null;
    sizeBytes: number;
    filePath: string;
  }): MediaRow {
    const row: MediaRow = {
      id: randomUUID(),
      public_id: makePublicId(),
      owner_user_id: input.ownerUserId,
      filename: input.filename,
      original_filename: input.originalFilename,
      mime_type: input.mimeType,
      width: input.width ?? null,
      height: input.height ?? null,
      size_bytes: input.sizeBytes,
      path: input.filePath,
      created_at: new Date().toISOString()
    };
    this.run(
      "INSERT INTO media (id, public_id, owner_user_id, filename, original_filename, mime_type, width, height, size_bytes, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        row.id,
        row.public_id,
        row.owner_user_id,
        row.filename,
        row.original_filename,
        row.mime_type,
        row.width,
        row.height,
        row.size_bytes,
        row.path,
        row.created_at
      ]
    );
    return row;
  }

  listMediaForUser(ownerUserId: string): MediaRow[] {
    return this.all<MediaRow>("SELECT * FROM media WHERE owner_user_id = ? ORDER BY created_at DESC", [ownerUserId]);
  }

  listMediaPaths(): string[] {
    return this.all<{ path: string }>("SELECT path FROM media").map((row) => row.path);
  }

  getMediaUsageForUser(ownerUserId: string): { itemCount: number; sizeBytes: number } {
    const row = this.get<{ item_count: number; size_bytes: number }>(
      "SELECT COUNT(*) AS item_count, COALESCE(SUM(size_bytes), 0) AS size_bytes FROM media WHERE owner_user_id = ?",
      [ownerUserId]
    );
    return { itemCount: Number(row?.item_count || 0), sizeBytes: Number(row?.size_bytes || 0) };
  }

  getGlobalMediaUsage(): { itemCount: number; sizeBytes: number } {
    const row = this.get<{ item_count: number; size_bytes: number }>(
      "SELECT COUNT(*) AS item_count, COALESCE(SUM(size_bytes), 0) AS size_bytes FROM media"
    );
    return { itemCount: Number(row?.item_count || 0), sizeBytes: Number(row?.size_bytes || 0) };
  }

  getMediaForUser(id: string, ownerUserId: string): MediaRow | undefined {
    return this.get<MediaRow>("SELECT * FROM media WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
  }

  getMediaForUserByIds(ids: string[], ownerUserId: string): MediaRow[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    return this.all<MediaRow>(`SELECT * FROM media WHERE owner_user_id = ? AND id IN (${placeholders})`, [ownerUserId, ...uniqueIds]);
  }

  getMediaByPublicId(publicId: string): MediaRow | undefined {
    return this.get<MediaRow>("SELECT * FROM media WHERE public_id = ?", [publicId]);
  }

  isMediaReferenced(row: MediaRow): boolean {
    const needles = new Set([row.id, row.public_id, `/api/v1/media/file/${row.public_id}`, `/api/media/file/${row.public_id}`]);
    const documents = [
      ...this.all<{ json: string }>("SELECT state_json AS json FROM presets WHERE owner_user_id = ?", [row.owner_user_id]),
      ...this.all<{ json: string }>("SELECT team_json AS json FROM teams WHERE owner_user_id = ?", [row.owner_user_id])
    ];
    return documents.some(({ json }) => {
      try {
        return jsonContainsReference(JSON.parse(json) as unknown, needles);
      } catch {
        return false;
      }
    });
  }

  deleteMedia(id: string, ownerUserId: string): MediaRow | undefined {
    const row = this.getMediaForUser(id, ownerUserId);
    if (!row) return undefined;
    this.run("DELETE FROM media WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
    return row;
  }

  logEvent(input: { presetId: string; ownerUserId: string; type: string; payload: Record<string, unknown> }): EventLogRow {
    const payloadJson = JSON.stringify(input.payload);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new RangeError(`Event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
    }
    const row: EventLogRow = {
      id: randomUUID(),
      preset_id: input.presetId,
      owner_user_id: input.ownerUserId,
      type: input.type,
      payload_json: payloadJson,
      created_at: new Date().toISOString()
    };
    this.run("INSERT INTO event_logs (id, preset_id, owner_user_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
      row.id,
      row.preset_id,
      row.owner_user_id,
      row.type,
      row.payload_json,
      row.created_at
    ]);
    this.run(
      "DELETE FROM event_logs WHERE preset_id = ? AND owner_user_id = ? AND id NOT IN (SELECT id FROM event_logs WHERE preset_id = ? AND owner_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)",
      [row.preset_id, row.owner_user_id, row.preset_id, row.owner_user_id, MAX_EVENT_LOGS_PER_PRESET]
    );
    return row;
  }

  getEventLog(presetId: string, ownerUserId: string, limit = 100): EventLogRow[] {
    return this.all<EventLogRow>(
      "SELECT * FROM event_logs WHERE preset_id = ? AND owner_user_id = ? ORDER BY created_at DESC LIMIT ?",
      [presetId, ownerUserId, limit]
    );
  }

  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
      `);
      const appliedVersion = Number(this.get<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")?.version || 0);
      if (appliedVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(`Database schema version ${appliedVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`);
      }
      if (appliedVersion < 1) this.applyInitialSchema();
      if (appliedVersion < 2) this.applySessionRevocationSchema();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyInitialSchema(): void {
    this.db.exec(`

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS presets (
        id TEXT PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('soccer', 'church', 'custom')),
        state_json TEXT NOT NULL,
        action_key_hash TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_presets_owner ON presets(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_presets_public_id ON presets(public_id);

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        team_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        size_bytes INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_media_public_id ON media(public_id);

      CREATE TABLE IF NOT EXISTS event_logs (
        id TEXT PRIMARY KEY,
        preset_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (preset_id) REFERENCES presets(id) ON DELETE CASCADE,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_event_logs_preset ON event_logs(preset_id, created_at DESC);
    `);
    const presetColumns = this.all<{ name: string }>("PRAGMA table_info(presets)");
    if (!presetColumns.some((column) => column.name === "revision")) {
      this.db.exec("ALTER TABLE presets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    const teamColumns = this.all<{ name: string }>("PRAGMA table_info(teams)");
    if (!teamColumns.some((column) => column.name === "revision")) {
      this.db.exec("ALTER TABLE teams ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [1, new Date().toISOString()]);
  }

  private applySessionRevocationSchema(): void {
    const userColumns = this.all<{ name: string }>("PRAGMA table_info(users)");
    if (!userColumns.some((column) => column.name === "session_version")) {
      this.db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1");
    }
    this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [2, new Date().toISOString()]);
  }
}

export function parsePresetState(row: PresetRow): PresetState {
  return JSON.parse(row.state_json) as PresetState;
}

export function parseTeam(row: TeamRow): TeamLibraryEntry {
  return JSON.parse(row.team_json) as TeamLibraryEntry;
}

export function makePublicId(): string {
  return randomBytes(18).toString("base64url");
}

function jsonContainsReference(value: unknown, needles: Set<string>, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof value === "string") {
    if (needles.has(value)) return true;
    return [...needles].some((needle) => needle.startsWith("/") && value.includes(needle));
  }
  if (Array.isArray(value)) return value.some((item) => jsonContainsReference(item, needles, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((item) => jsonContainsReference(item, needles, depth + 1));
}
