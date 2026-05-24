import type { Server as HttpServer } from "node:http";
import cookie from "cookie";
import { Server, type Socket } from "socket.io";
import { parsePresetState, type PresetRow } from "./db.js";
import { verifySessionToken, sessionCookieName } from "./auth.js";
import { materializeState } from "./state.js";
import type { AppContext } from "./types.js";

export interface RealtimeHub {
  io: Server;
  broadcastPreset(row: PresetRow): void;
  broadcastConnectionCount(row: PresetRow): void;
  getOverlayClientCount(publicId: string): number;
}

export function attachRealtime(server: HttpServer, ctx: AppContext): RealtimeHub {
  const overlayClients = new Map<string, Set<string>>();
  const io = new Server(server, {
    cors: {
      origin(origin, callback) {
        if (!origin || ctx.config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS origin not allowed"));
      },
      credentials: true
    }
  });

  const hub: RealtimeHub = {
    io,
    broadcastPreset(row) {
      const state = materializeState(parsePresetState(row));
      io.to(`overlay:${row.public_id}`).emit("state:update", publicPayload(row, state));
      io.to(`admin:${row.id}`).emit("preset:update", privatePayload(row, state, hub.getOverlayClientCount(row.public_id)));
    },
    broadcastConnectionCount(row) {
      io.to(`admin:${row.id}`).emit("overlay:clients", { presetId: row.id, publicId: row.public_id, count: hub.getOverlayClientCount(row.public_id) });
    },
    getOverlayClientCount(publicId) {
      return overlayClients.get(publicId)?.size || 0;
    }
  };

  io.on("connection", (socket) => {
    void handleSocket(socket, ctx, hub, overlayClients);
  });

  return hub;
}

async function handleSocket(
  socket: Socket,
  ctx: AppContext,
  hub: RealtimeHub,
  overlayClients: Map<string, Set<string>>
): Promise<void> {
  const overlayId = stringQuery(socket, "overlayId");
  const presetId = stringQuery(socket, "presetId");
  const role = stringQuery(socket, "role");

  if (overlayId && role === "overlay") {
    const row = ctx.db.getPresetByPublicId(overlayId);
    if (!row) {
      socket.emit("error:message", { error: "Overlay not found" });
      socket.disconnect(true);
      return;
    }
    socket.join(`overlay:${row.public_id}`);
    const set = overlayClients.get(row.public_id) || new Set<string>();
    set.add(socket.id);
    overlayClients.set(row.public_id, set);
    socket.emit("state:update", publicPayload(row, materializeState(parsePresetState(row))));
    hub.broadcastConnectionCount(row);
    socket.on("disconnect", () => {
      set.delete(socket.id);
      hub.broadcastConnectionCount(row);
    });
    return;
  }

  if (presetId && role === "admin") {
    const user = authenticateSocket(socket, ctx);
    if (!user) {
      socket.emit("error:message", { error: "Authentication required" });
      socket.disconnect(true);
      return;
    }
    const row = ctx.db.getPresetForUser(presetId, user.id);
    if (!row) {
      socket.emit("error:message", { error: "Preset not found" });
      socket.disconnect(true);
      return;
    }
    socket.join(`admin:${row.id}`);
    socket.emit("preset:update", privatePayload(row, materializeState(parsePresetState(row)), hub.getOverlayClientCount(row.public_id)));
    socket.emit("overlay:clients", { presetId: row.id, publicId: row.public_id, count: hub.getOverlayClientCount(row.public_id) });
    return;
  }

  socket.disconnect(true);
}

function authenticateSocket(socket: Socket, ctx: AppContext) {
  const rawCookie = socket.request.headers.cookie || "";
  const cookies = cookie.parse(rawCookie);
  const token = cookies[sessionCookieName()] || socket.handshake.auth?.token;
  const payload = verifySessionToken(token, ctx.config.jwtSecret);
  if (!payload) return null;
  const user = ctx.db.findUserById(payload.sub);
  return user ? { id: user.id, email: user.email } : null;
}

function stringQuery(socket: Socket, key: string): string | undefined {
  const value = socket.handshake.query[key] || socket.handshake.auth?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function publicPayload(row: PresetRow, state: unknown) {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    type: row.type,
    state,
    updatedAt: row.updated_at
  };
}

function privatePayload(row: PresetRow, state: unknown, overlayClientCount: number) {
  return {
    ...publicPayload(row, state),
    overlayClientCount
  };
}
