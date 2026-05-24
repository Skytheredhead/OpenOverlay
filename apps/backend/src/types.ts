import type { Request } from "express";
import type { Database } from "./db.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { RealtimeHub } from "./realtime.js";

export interface AuthUser {
  id: string;
  email: string;
}

export interface AppContext {
  config: AppConfig;
  db: Database;
  logger: Logger;
  realtime?: RealtimeHub;
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

declare global {
  namespace Express {
    interface Request {
      ctx?: AppContext;
      user?: AuthUser;
    }
  }
}
