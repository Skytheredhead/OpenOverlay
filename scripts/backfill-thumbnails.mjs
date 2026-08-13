#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

try {
  const databasePath = path.resolve(process.env.DATABASE_PATH || "./data/openoverlay.sqlite");
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(databasePath), "uploads"));
  const limit = Number(process.env.THUMBNAIL_BACKFILL_LIMIT || 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("THUMBNAIL_BACKFILL_LIMIT must be from 1 to 1000");
  const database = new DatabaseSync(databasePath);
  const rows = database
    .prepare("SELECT id, path FROM media WHERE thumbnail_path IS NULL AND mime_type != 'image/svg+xml' ORDER BY created_at, id LIMIT ?")
    .all(limit);
  let completed = 0;
  for (const row of rows) {
    const source = path.resolve(String(row.path));
    if (!source.startsWith(`${uploadDir}${path.sep}`) || !fs.lstatSync(source).isFile()) throw new Error(`Unsafe or missing media path for ${String(row.id)}`);
    const destination = path.join(uploadDir, `${String(row.id)}-thumbnail.webp`);
    if (fs.existsSync(destination) && !fs.lstatSync(destination).isFile()) throw new Error(`Thumbnail path is not a regular file: ${destination}`);
    const temporary = `${destination}.uploading-backfill`;
    try {
      const info = await sharp(source, { limitInputPixels: 40_000_000, failOn: "error" })
        .rotate()
        .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toFile(temporary);
      fs.renameSync(temporary, destination);
      database
        .prepare(
          "UPDATE media SET thumbnail_path = ?, thumbnail_width = ?, thumbnail_height = ?, thumbnail_mime_type = 'image/webp', thumbnail_size_bytes = ? WHERE id = ? AND thumbnail_path IS NULL"
        )
        .run(destination, info.width, info.height, info.size, row.id);
      completed += 1;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  database.close();
  console.log(JSON.stringify({ ok: true, scanned: rows.length, completed }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Thumbnail backfill failed");
  process.exitCode = 1;
}
