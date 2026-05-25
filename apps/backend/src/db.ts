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
  created_at: string;
  updated_at: string;
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

export class Database {
  private readonly db: DatabaseSync;

  constructor(private readonly config: AppConfig) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    fs.mkdirSync(config.uploadDir, { recursive: true });
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
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

  createUser(email: string, passwordHash: string): UserRow {
    const now = new Date().toISOString();
    const row: UserRow = {
      id: randomUUID(),
      email: email.toLowerCase(),
      password_hash: passwordHash,
      created_at: now
    };
    this.run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)", [
      row.id,
      row.email,
      row.password_hash,
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
      created_at: now,
      updated_at: now
    };
    this.run(
      "INSERT INTO presets (id, public_id, owner_user_id, name, type, state_json, action_key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [row.id, row.public_id, row.owner_user_id, row.name, row.type, row.state_json, row.action_key_hash, row.created_at, row.updated_at]
    );
    return row;
  }

  listPresetsForUser(ownerUserId: string): PresetRow[] {
    return this.all<PresetRow>("SELECT * FROM presets WHERE owner_user_id = ? ORDER BY updated_at DESC", [ownerUserId]);
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
  }): PresetRow | undefined {
    const existing = this.getPresetForUser(input.id, input.ownerUserId);
    if (!existing) return undefined;
    const next: PresetRow = {
      ...existing,
      name: input.name ?? existing.name,
      state_json: input.state ? JSON.stringify(input.state) : existing.state_json,
      action_key_hash: input.actionKeyHash === undefined ? existing.action_key_hash : input.actionKeyHash,
      updated_at: new Date().toISOString()
    };
    this.run(
      "UPDATE presets SET name = ?, state_json = ?, action_key_hash = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
      [next.name, next.state_json, next.action_key_hash, next.updated_at, input.id, input.ownerUserId]
    );
    return next;
  }

  deletePreset(id: string, ownerUserId: string): boolean {
    const result = this.run("DELETE FROM presets WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
    return result.changes > 0;
  }

  createTeam(input: { ownerUserId: string; team: Omit<TeamLibraryEntry, "id" | "createdAt" | "updatedAt"> }): TeamRow {
    const now = new Date().toISOString();
    const id = randomUUID();
    const team: TeamLibraryEntry = {
      ...input.team,
      id,
      createdAt: now,
      updatedAt: now
    };
    const row: TeamRow = {
      id,
      owner_user_id: input.ownerUserId,
      team_json: JSON.stringify(team),
      created_at: now,
      updated_at: now
    };
    this.run("INSERT INTO teams (id, owner_user_id, team_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
      row.id,
      row.owner_user_id,
      row.team_json,
      row.created_at,
      row.updated_at
    ]);
    return row;
  }

  listTeamsForUser(ownerUserId: string): TeamRow[] {
    return this.all<TeamRow>("SELECT * FROM teams WHERE owner_user_id = ? ORDER BY updated_at DESC", [ownerUserId]);
  }

  getTeamForUser(id: string, ownerUserId: string): TeamRow | undefined {
    return this.get<TeamRow>("SELECT * FROM teams WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
  }

  updateTeam(input: { id: string; ownerUserId: string; team: TeamLibraryEntry }): TeamRow | undefined {
    const existing = this.getTeamForUser(input.id, input.ownerUserId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const team: TeamLibraryEntry = { ...input.team, id: existing.id, createdAt: parseTeam(existing).createdAt, updatedAt: now };
    const row: TeamRow = {
      ...existing,
      team_json: JSON.stringify(team),
      updated_at: now
    };
    this.run("UPDATE teams SET team_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?", [
      row.team_json,
      row.updated_at,
      input.id,
      input.ownerUserId
    ]);
    return row;
  }

  deleteTeam(id: string, ownerUserId: string): boolean {
    const result = this.run("DELETE FROM teams WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
    return result.changes > 0;
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

  getMediaForUser(id: string, ownerUserId: string): MediaRow | undefined {
    return this.get<MediaRow>("SELECT * FROM media WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
  }

  getMediaByPublicId(publicId: string): MediaRow | undefined {
    return this.get<MediaRow>("SELECT * FROM media WHERE public_id = ?", [publicId]);
  }

  deleteMedia(id: string, ownerUserId: string): MediaRow | undefined {
    const row = this.getMediaForUser(id, ownerUserId);
    if (!row) return undefined;
    this.run("DELETE FROM media WHERE id = ? AND owner_user_id = ?", [id, ownerUserId]);
    return row;
  }

  logEvent(input: { presetId: string; ownerUserId: string; type: string; payload: Record<string, unknown> }): EventLogRow {
    const row: EventLogRow = {
      id: randomUUID(),
      preset_id: input.presetId,
      owner_user_id: input.ownerUserId,
      type: input.type,
      payload_json: JSON.stringify(input.payload),
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
    return row;
  }

  getEventLog(presetId: string, ownerUserId: string, limit = 100): EventLogRow[] {
    return this.all<EventLogRow>(
      "SELECT * FROM event_logs WHERE preset_id = ? AND owner_user_id = ? ORDER BY created_at DESC LIMIT ?",
      [presetId, ownerUserId, limit]
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

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
