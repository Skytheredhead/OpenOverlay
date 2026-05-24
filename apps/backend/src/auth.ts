import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import type { AppContext, AuthUser } from "./types.js";

const SESSION_COOKIE = "openoverlay_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SessionPayload {
  sub: string;
  exp: number;
}

interface FailedLoginBucket {
  attempts: number;
  firstAt: number;
  blockedUntil: number;
}

const failedLogins = new Map<string, FailedLoginBucket>();

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createSessionToken(userId: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload: SessionPayload = {
    sub: userId,
    exp: nowSeconds + SESSION_TTL_SECONDS
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(body, secret);
  return `${body}.${signature}`;
}

export function verifySessionToken(token: string | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): SessionPayload | null {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = sign(body, secret);
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.sub || payload.exp < nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, ctx: AppContext, userId: string): void {
  const token = createSessionToken(userId, ctx.config.jwtSecret);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.config.env === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
    domain: ctx.config.cookieDomain
  });
}

export function clearSessionCookie(res: Response, ctx: AppContext): void {
  res.clearCookie(SESSION_COOKIE, {
    path: "/",
    domain: ctx.config.cookieDomain
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const ctx = req.ctx;
  if (!ctx) {
    res.status(500).json({ error: "Missing app context" });
    return;
  }

  const token =
    req.cookies?.[SESSION_COOKIE] ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.header("x-openoverlay-session");
  const payload = verifySessionToken(token, ctx.config.jwtSecret);
  if (!payload) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const user = ctx.db.findUserById(payload.sub);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  req.user = { id: user.id, email: user.email };
  next();
}

export function serializeUser(user: AuthUser) {
  return { id: user.id, email: user.email };
}

export function validateEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8 || password.length > 200) return null;
  return password;
}

export function assertLoginAllowed(email: string, ip: string): void {
  const key = `${email}:${ip}`;
  const bucket = failedLogins.get(key);
  const now = Date.now();
  if (!bucket) return;
  if (bucket.blockedUntil > now) {
    const seconds = Math.ceil((bucket.blockedUntil - now) / 1000);
    throw new Error(`Too many failed attempts. Try again in ${seconds} seconds.`);
  }
  if (now - bucket.firstAt > 15 * 60 * 1000) {
    failedLogins.delete(key);
  }
}

export function recordFailedLogin(email: string, ip: string): void {
  const key = `${email}:${ip}`;
  const now = Date.now();
  const existing = failedLogins.get(key);
  if (!existing || now - existing.firstAt > 15 * 60 * 1000) {
    failedLogins.set(key, { attempts: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  existing.attempts += 1;
  if (existing.attempts >= 5) {
    existing.blockedUntil = now + 10 * 60 * 1000;
  }
}

export function recordSuccessfulLogin(email: string, ip: string): void {
  failedLogins.delete(`${email}:${ip}`);
}

export function generateActionKey(): string {
  return `ooa_${randomBytes(24).toString("base64url")}`;
}

export function hashActionKey(actionKey: string): string {
  return createHash("sha256").update(actionKey).digest("hex");
}

export function verifyActionKey(actionKey: string | undefined, actionKeyHash: string | null): boolean {
  if (!actionKey || !actionKeyHash) return false;
  return safeEqual(hashActionKey(actionKey), actionKeyHash);
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
