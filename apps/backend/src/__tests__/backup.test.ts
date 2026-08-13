import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const backupScript = path.join(repositoryRoot, "scripts/openoverlay-backup.mjs");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("backup and restore evidence", () => {
  it("creates a checksum-complete online snapshot and resolves a retained delete tombstone", () => {
    const fixture = createFixture();
    const result = runBackup([
      "create",
      "--kind",
      "predeploy",
      "--root",
      fixture.backupRoot,
      "--database",
      fixture.databasePath,
      "--uploads",
      fixture.uploadDir,
      "--build-sha",
      "a".repeat(40)
    ]);
    expect(result.status).toBe(0);
    const created = JSON.parse(result.stdout.trim()) as { snapshot: string; mediaFiles: number };
    expect(created.mediaFiles).toBe(1);
    expect(fs.existsSync(path.join(created.snapshot, ".valid"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(created.snapshot, "manifest.json"), "utf8"))).toMatchObject({
      buildSha: "a".repeat(40),
      schemaVersion: 2,
      integrityCheck: "ok",
      media: [{ rowId: "media-1", kind: "original" }]
    });

    const verified = runBackup(["verify", "--snapshot", created.snapshot]);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, mediaFiles: 1 });
  });

  it("never accepts a snapshot after database bytes are corrupted", () => {
    const fixture = createFixture();
    const created = JSON.parse(
      runBackup([
        "create",
        "--kind",
        "daily",
        "--root",
        fixture.backupRoot,
        "--database",
        fixture.databasePath,
        "--uploads",
        fixture.uploadDir,
        "--build-sha",
        "b".repeat(40)
      ]).stdout
    ) as { snapshot: string };
    fs.appendFileSync(path.join(created.snapshot, "openoverlay.sqlite"), "corruption");

    const verified = runBackup(["verify", "--snapshot", created.snapshot]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toMatch(/checksum does not match/);
  });
});

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-backup-test-"));
  directories.push(directory);
  const databasePath = path.join(directory, "openoverlay.sqlite");
  const uploadDir = path.join(directory, "uploads");
  const backupRoot = path.join(directory, "backups");
  fs.mkdirSync(uploadDir);
  const originalPath = path.join(uploadDir, "graphic.png");
  const tombstonePath = `${originalPath}.deleting-test`;
  fs.writeFileSync(tombstonePath, "stable-media-bytes");

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (2, '2026-01-01T00:00:00.000Z');
    CREATE TABLE media (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO media VALUES (?, ?, ?, ?)").run("media-1", originalPath, 18, "2026-01-01T00:00:00.000Z");
  database.close();
  return { databasePath, uploadDir, backupRoot };
}

function runBackup(args: string[]) {
  return spawnSync(process.execPath, [backupScript, ...args], { cwd: repositoryRoot, encoding: "utf8" });
}
