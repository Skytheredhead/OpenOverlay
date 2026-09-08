import fs from "node:fs";

const output = fs.readFileSync(0, "utf8").trim();
let candidate;
try {
  const result = JSON.parse(output);
  candidate = result?.deployment?.url;
} catch {
  // Older CLI releases print the URL on its own line instead of JSON.
  candidate = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("https://"))
    .at(-1);
}

try {
  const url = new URL(candidate);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".vercel.app") ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid deployment URL");
  process.stdout.write(url.origin);
} catch {
  console.error("Vercel did not return a valid HTTPS deployment URL.");
  process.exitCode = 1;
}
