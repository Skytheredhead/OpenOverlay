import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildCommit } from "../buildInfo.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("backend build identity", () => {
  it("prefers the compiled artifact marker over a stale service environment", () => {
    const moduleDirectory = temporaryModuleDirectory("dist");
    fs.writeFileSync(path.join(moduleDirectory, ".openoverlay-build-commit"), "artifact-sha\n");

    expect(resolveBuildCommit(moduleDirectory, { OPENOVERLAY_GIT_SHA: "stale-service-sha" }, () => "mutable-checkout-sha")).toBe("artifact-sha");
  });

  it("does not describe an unmarked dist artifact using the mutable checkout", () => {
    const moduleDirectory = temporaryModuleDirectory("dist");

    expect(resolveBuildCommit(moduleDirectory, {}, () => "mutable-checkout-sha")).toBeNull();
  });
});

function temporaryModuleDirectory(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-build-info-"));
  temporaryDirectories.push(parent);
  const directory = path.join(parent, name);
  fs.mkdirSync(directory);
  return directory;
}
