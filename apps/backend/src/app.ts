import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import multer from "multer";
import { imageSize } from "image-size";
import {
  createDefaultPresetState,
  defaultTeam,
  parseRoster,
  parseClockTime,
  setClockSeconds,
  type PresetState,
  type PresetType,
  type SoccerState,
  type TeamLibraryEntry,
  type TeamRecord
} from "@openoverlay/shared";
import { assertLoginAllowed, clearSessionCookie, generateActionKey, hashActionKey, hashPassword, recordFailedLogin, recordSuccessfulLogin, requireAuth, serializeUser, setSessionCookie, validateEmail, validatePassword, verifyActionKey, verifyPassword, verifySessionToken, sessionCookieName } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { Database, parsePresetState, parseTeam, type MediaRow, type PresetRow, type TeamRow } from "./db.js";
import { createLogger } from "./logger.js";
import { applyAction, cloneStateForShare, ensurePresetState, isSoccerState, materializeState, mergePresetState, type PresetAction } from "./state.js";
import type { AppContext } from "./types.js";

export interface BackendApp {
  app: express.Express;
  ctx: AppContext;
  close(): void;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  }
});

const allowedMimes = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);
const extensionByMime: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
  "image/webp": ".webp"
};

class UploadValidationError extends Error {}

export function createBackendApp(configOverrides: Partial<AppConfig> = {}): BackendApp {
  const config = loadConfig(configOverrides);
  const logger = createLogger(config.logFile);
  const db = new Database(config);
  const ctx: AppContext = { config, db, logger };
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS origin not allowed"));
      },
      credentials: true
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.ctx = ctx;
    next();
  });
  app.use((req, res, next) => {
    res.on("finish", () => {
      if (req.path !== "/health") {
        logger.info("http_request", { method: req.method, path: req.path, status: res.statusCode });
      }
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, app: "OpenOverlay", time: new Date().toISOString() });
  });

  app.post("/api/auth/signup", asyncHandler(async (req, res) => {
    const email = validateEmail(req.body.email);
    const password = validatePassword(req.body.password);
    if (!email || !password) {
      res.status(400).json({ error: "Valid email and password of at least 8 characters are required" });
      return;
    }
    if (db.findUserByEmail(email)) {
      res.status(409).json({ error: "An account already exists for that email" });
      return;
    }
    const user = db.createUser(email, await hashPassword(password));
    setSessionCookie(res, ctx, user.id);
    res.status(201).json({ user: serializeUser({ id: user.id, email: user.email }) });
  }));

  app.post("/api/auth/login", asyncHandler(async (req, res) => {
    const email = validateEmail(req.body.email);
    const password = validatePassword(req.body.password);
    if (!email || !password) {
      res.status(400).json({ error: "Valid email and password are required" });
      return;
    }
    const ip = req.ip || "unknown";
    try {
      const user = db.findUserByEmail(email);
      assertLoginAllowed(email, ip);
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        recordFailedLogin(email, ip);
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }
      recordSuccessfulLogin(email, ip);
      setSessionCookie(res, ctx, user.id);
      res.json({ user: serializeUser({ id: user.id, email: user.email }) });
    } catch (error) {
      res.status(429).json({ error: error instanceof Error ? error.message : "Too many failed attempts" });
    }
  }));

  app.post("/api/auth/logout", (req, res) => {
    clearSessionCookie(res, ctx);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: serializeUser(req.user!) });
  });

  app.get("/api/teams", requireAuth, (req, res) => {
    res.json({ teams: db.listTeamsForUser(req.user!.id).map((row) => serializeTeam(row)) });
  });

  app.post("/api/teams", requireAuth, (req, res) => {
    const team = sanitizeTeamInput(req.body || {});
    const row = db.createTeam({ ownerUserId: req.user!.id, team });
    res.status(201).json({ team: serializeTeam(row) });
  });

  app.patch("/api/teams/:id", requireAuth, (req, res) => {
    const existing = db.getTeamForUser(routeParam(req, "id"), req.user!.id);
    if (!existing) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    const current = serializeTeam(existing);
    const team = { ...sanitizeTeamInput(req.body || {}, current), id: current.id, createdAt: current.createdAt, updatedAt: current.updatedAt };
    const updated = db.updateTeam({ id: current.id, ownerUserId: req.user!.id, team });
    if (!updated) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    res.json({ team: serializeTeam(updated) });
  });

  app.delete("/api/teams/:id", requireAuth, (req, res) => {
    const deleted = db.deleteTeam(routeParam(req, "id"), req.user!.id);
    if (!deleted) {
      res.status(404).json({ error: "Team not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/presets", requireAuth, (req, res) => {
    res.json({
      presets: db.listPresetsForUser(req.user!.id).map((row) => serializePreset(row, ctx))
    });
  });

  app.post("/api/presets", requireAuth, (req, res) => {
    const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : "Untitled";
    const type: PresetType = req.body.type === "church" || req.body.type === "custom" ? req.body.type : "soccer";
    const state = ensurePresetState(type, name, req.body.state as PresetState | undefined);
    const row = db.createPreset({ ownerUserId: req.user!.id, name, type, state });
    db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "preset.create", payload: { type } });
    res.status(201).json({ preset: serializePreset(row, ctx) });
  });

  app.get("/api/presets/:id", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    res.json({ preset: serializePreset(row, ctx) });
  });

  app.patch("/api/presets/:id", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const existingState = materializeState(parsePresetState(row));
    const nextState = req.body.state ? (req.body.state as PresetState) : req.body.statePatch ? mergePresetState(existingState, req.body.statePatch) : existingState;
    const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : undefined;
    const updated = db.updatePreset({ id: row.id, ownerUserId: req.user!.id, name, state: nextState });
    if (!updated) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "preset.update", payload: { nameChanged: Boolean(name) } });
    ctx.realtime?.broadcastPreset(updated);
    res.json({ preset: serializePreset(updated, ctx) });
  });

  app.delete("/api/presets/:id", requireAuth, (req, res) => {
    const deleted = db.deletePreset(routeParam(req, "id"), req.user!.id);
    if (!deleted) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/presets/:id/duplicate", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const copyName = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : `${row.name} Copy`;
    const created = db.createPreset({
      ownerUserId: req.user!.id,
      name: copyName,
      type: row.type,
      state: cloneStateForShare(parsePresetState(row))
    });
    res.status(201).json({ preset: serializePreset(created, ctx) });
  });

  app.post("/api/presets/:id/share", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    const recipientEmail = validateEmail(req.body.email);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    if (!recipientEmail) {
      res.status(400).json({ error: "Recipient email is required" });
      return;
    }
    const recipient = db.findUserByEmail(recipientEmail);
    if (!recipient) {
      res.status(404).json({ error: "Recipient account not found" });
      return;
    }
    const created = db.createPreset({
      ownerUserId: recipient.id,
      name: row.name,
      type: row.type,
      state: cloneStateForShare(parsePresetState(row))
    });
    db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "preset.share", payload: { recipientEmail } });
    res.status(201).json({ preset: serializePreset(created, ctx) });
  });

  app.post("/api/presets/:id/share-team", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    const recipientEmail = validateEmail(req.body.email);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const state = parsePresetState(row);
    if (!recipientEmail || !isSoccerState(state)) {
      res.status(400).json({ error: "Recipient email and soccer preset are required" });
      return;
    }
    const recipient = db.findUserByEmail(recipientEmail);
    if (!recipient) {
      res.status(404).json({ error: "Recipient account not found" });
      return;
    }
    const side = req.body.side === "away" ? "away" : "home";
    const copiedState = createDefaultPresetState("soccer", `${state[side].shortName} Team`);
    if (isSoccerState(copiedState)) {
      copiedState.home = (cloneStateForShare(state) as SoccerState)[side];
    }
    const created = db.createPreset({ ownerUserId: recipient.id, name: `${state[side].shortName} Team`, type: "soccer", state: copiedState });
    res.status(201).json({ preset: serializePreset(created, ctx) });
  });

  app.post("/api/presets/:id/action-key", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const actionKey = generateActionKey();
    const updated = db.updatePreset({ id: row.id, ownerUserId: req.user!.id, actionKeyHash: hashActionKey(actionKey) });
    res.json({ actionKey, preset: updated ? serializePreset(updated, ctx) : undefined });
  });

  app.get("/api/presets/:id/events", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    res.json({ events: db.getEventLog(row.id, req.user!.id) });
  });

  app.get("/api/presets/:id/soccer", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const state = materializeState(parsePresetState(row));
    if (!isSoccerState(state)) {
      res.status(400).json({ error: "Preset is not a soccer preset" });
      return;
    }
    res.json({ state });
  });

  app.patch("/api/presets/:id/soccer", requireAuth, (req, res) => {
    const row = db.getPresetForUser(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const state = materializeState(parsePresetState(row));
    if (!isSoccerState(state)) {
      res.status(400).json({ error: "Preset is not a soccer preset" });
      return;
    }
    let nextState = mergePresetState(state, req.body.statePatch || req.body) as PresetState;
    if (isSoccerState(nextState) && typeof req.body.clockTime === "string") {
      nextState = { ...nextState, clock: setClockSeconds(nextState.clock, parseClockTime(req.body.clockTime)) };
    }
    const updated = db.updatePreset({ id: row.id, ownerUserId: req.user!.id, state: nextState });
    if (!updated) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    db.logEvent({ presetId: row.id, ownerUserId: req.user!.id, type: "soccer.update", payload: {} });
    ctx.realtime?.broadcastPreset(updated);
    res.json({ preset: serializePreset(updated, ctx) });
  });

  app.post("/api/presets/:id/actions/:action", asyncHandler(async (req, res) => {
    const row = authorizePresetAction(req, ctx, routeParam(req, "id"));
    if (!row) {
      res.status(401).json({ error: "Authentication or valid action key required" });
      return;
    }
    const action = routeParam(req, "action") as PresetAction;
    const state = applyAction(parsePresetState(row), action, req.body || {});
    const updated = db.updatePreset({ id: row.id, ownerUserId: row.owner_user_id, state });
    if (!updated) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    db.logEvent({ presetId: row.id, ownerUserId: row.owner_user_id, type: `action.${action}`, payload: sanitizeEventPayload(req.body || {}) });
    ctx.realtime?.broadcastPreset(updated);
    res.json({ preset: serializePreset(updated, ctx) });
  }));

  app.get("/api/overlay/:publicId", (req, res) => {
    const row = db.getPresetByPublicId(routeParam(req, "publicId"));
    if (!row) {
      res.status(404).json({ error: "Overlay not found" });
      return;
    }
    const state = materializeState(parsePresetState(row));
    res.json({
      overlay: {
        id: row.id,
        publicId: row.public_id,
        name: row.name,
        type: row.type,
        state,
        updatedAt: row.updated_at
      }
    });
  });

  app.get("/api/media", requireAuth, (req, res) => {
    res.json({ media: db.listMediaForUser(req.user!.id).map((row) => serializeMedia(row)) });
  });

  app.post("/api/media", requireAuth, upload.single("file"), asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "File is required" });
      return;
    }
    const media = await saveMediaUpload(ctx, req.user!.id, req.file);
    res.status(201).json({ media: serializeMedia(media) });
  }));

  app.delete("/api/media/:id", requireAuth, (req, res) => {
    const row = db.deleteMedia(routeParam(req, "id"), req.user!.id);
    if (!row) {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    fs.rm(row.path, { force: true }, () => undefined);
    res.json({ ok: true });
  });

  app.get("/api/media/file/:publicId", (req, res) => {
    const row = db.getMediaByPublicId(routeParam(req, "publicId"));
    if (!row || !fs.existsSync(row.path)) {
      res.status(404).send("Not found");
      return;
    }
    if (row.mime_type === "image/svg+xml") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    }
    res.setHeader("Content-Type", row.mime_type);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(row.path);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("request_error", { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof UploadValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });

  return {
    app,
    ctx,
    close() {
      db.close();
    }
  };
}

function authorizePresetAction(req: Request, ctx: AppContext, presetId: string): PresetRow | null {
  const row = ctx.db.getPresetById(presetId);
  if (!row) return null;
  const token =
    req.cookies?.[sessionCookieName()] ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.header("x-openoverlay-session");
  const payload = verifySessionToken(token, ctx.config.jwtSecret);
  if (payload?.sub === row.owner_user_id) return row;
  const actionKey =
    req.header("x-openoverlay-action-key") ||
    (typeof req.query.key === "string" ? req.query.key : undefined) ||
    (typeof req.body?.actionKey === "string" ? req.body.actionKey : undefined);
  return verifyActionKey(actionKey, row.action_key_hash) ? row : null;
}

function routeParam(req: Request, key: string): string {
  const value = req.params[key];
  return (Array.isArray(value) ? value[0] : value) || "";
}

function serializePreset(row: PresetRow, ctx: AppContext) {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    type: row.type,
    updatedAt: row.updated_at,
    overlayClientCount: ctx.realtime?.getOverlayClientCount(row.public_id) || 0,
    state: materializeState(parsePresetState(row))
  };
}

function serializeMedia(row: MediaRow) {
  return {
    id: row.id,
    publicId: row.public_id,
    filename: row.filename,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    url: `/api/media/file/${row.public_id}`
  };
}

function serializeTeam(row: TeamRow): TeamLibraryEntry {
  return parseTeam(row);
}

function sanitizeTeamInput(body: Record<string, unknown>, fallback = defaultTeam("home")): Omit<TeamLibraryEntry, "id" | "createdAt" | "updatedAt"> {
  const fullName = stringField(body.fullName ?? body.name, fallback.fullName || "New Team").slice(0, 120);
  const shortName = stringField(body.shortName, fallback.shortName || fullName).slice(0, 48);
  const rosterText = stringField(body.rosterText, fallback.rosterText).slice(0, 10_000);
  return {
    fullName,
    shortName,
    abbreviation: stringField(body.abbreviation, fallback.abbreviation || shortName.slice(0, 3)).toUpperCase().slice(0, 5),
    logoMediaId: Object.hasOwn(body, "logoMediaId") ? optionalStringField(body.logoMediaId) : fallback.logoMediaId,
    logoUrl: Object.hasOwn(body, "logoUrl") ? optionalStringField(body.logoUrl) : fallback.logoUrl,
    primaryColor: colorField(body.primaryColor, fallback.primaryColor),
    secondaryColor: colorField(body.secondaryColor, fallback.secondaryColor),
    rosterText,
    roster: parseRoster(rosterText),
    coach: stringField(body.coach, fallback.coach).slice(0, 120),
    schoolName: stringField(body.schoolName, fallback.schoolName).slice(0, 120),
    record: sanitizeRecord(body.record, fallback.record)
  };
}

function sanitizeRecord(input: unknown, fallback?: TeamRecord): TeamRecord {
  const record = isRecord(input) ? input : {};
  return {
    wins: numberField(record.wins, fallback?.wins ?? 0),
    losses: numberField(record.losses, fallback?.losses ?? 0),
    draws: numberField(record.draws, fallback?.draws ?? 0)
  };
}

function stringField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function colorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function numberField(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function saveMediaUpload(ctx: AppContext, ownerUserId: string, file: Express.Multer.File): Promise<MediaRow> {
  if (!allowedMimes.has(file.mimetype)) {
    throw new UploadValidationError("Unsupported image type");
  }

  const extension = extensionByMime[file.mimetype];
  let width: number | null = null;
  let height: number | null = null;

  if (file.mimetype === "image/svg+xml") {
    validateSvg(file.buffer);
  } else {
    let dimensions: ReturnType<typeof imageSize>;
    try {
      dimensions = imageSize(file.buffer);
    } catch {
      throw new UploadValidationError("Invalid image file");
    }
    width = dimensions.width ?? null;
    height = dimensions.height ?? null;
  }

  const safeBase = path
    .basename(file.originalname, path.extname(file.originalname))
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const filename = `${Date.now()}-${safeBase || "upload"}${extension}`;
  const filePath = path.join(ctx.config.uploadDir, filename);
  await fs.promises.mkdir(ctx.config.uploadDir, { recursive: true });
  await fs.promises.writeFile(filePath, file.buffer, { mode: 0o640 });
  return ctx.db.createMedia({
    ownerUserId,
    filename,
    originalFilename: file.originalname,
    mimeType: file.mimetype,
    width,
    height,
    sizeBytes: file.size,
    filePath
  });
}

function validateSvg(buffer: Buffer): void {
  const svg = buffer.toString("utf8");
  if (!svg.trim().startsWith("<svg") && !svg.includes("<svg")) {
    throw new UploadValidationError("Invalid SVG");
  }
  if (/(<script|javascript:|on\w+\s*=|<foreignObject)/i.test(svg)) {
    throw new UploadValidationError("SVG contains unsafe content");
  }
}

function sanitizeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...payload };
  delete copy.actionKey;
  return copy;
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}
