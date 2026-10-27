import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
const paths = git("ls-files", "-z").split("\0").filter(Boolean);
const forbidden = paths.filter(
  (p) =>
      /(?:^|\/)(?:node_modules|\.cache|\.internal|artifacts|dist|bin|obj|\.vs)\//i.test(p) ||
    /(?:^|\/)(?:\.env(?:\..+)?|registration-backup\.json|com\.tabspace\.draggroup\.json)$|\.(?:pfx|pem|key)$/i.test(
      p,
    ),
);
if (forbidden.length)
  throw Error(`Private/generated tracked paths: ${forbidden.join(", ")}`);
const history = git(
  "log",
  "--all",
  "-p",
  "--format=commit:%H",
  "--no-ext-diff",
  "--unified=0",
);
const patterns = [
  [
    "private key",
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  ],
  [
    "GitHub credential",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["credential in URL", /https?:\/\/[^\s/:@]+:[^\s/@]{8,}@/],
];
let commit = "unknown",
  path = "unknown";
const findings = [];
for (const line of history.split("\n")) {
  if (line.startsWith("commit:")) commit = line.slice(7);
  if (line.startsWith("+++ b/")) path = line.slice(6);
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  for (const [kind, pattern] of patterns)
    if (pattern.test(line)) {
      // Intentional invalid-credential URLs in the two validation fixtures.
      if (
        kind === "credential in URL" &&
        ["tests/sync.test.ts", "tests/sync-setup.test.ts"].includes(path) &&
        /@cloud\.test(?:\/|["'])/.test(line)
      )
        continue;
      findings.push({ commit, path, kind });
    }
}
if (findings.length)
  throw Error(
    `Potential credentials in history (values omitted): ${JSON.stringify(findings)}`,
  );
await mkdir(resolve(root, "artifacts"), { recursive: true });
const report = {
  date: new Date().toISOString(),
  trackedFiles: paths.length,
  historyCommits: Number(git("rev-list", "--count", "--all").trim()),
  passed: true,
  scope:
    "Tracked-path exclusion and high-confidence credential patterns in added history lines. Bounded guard, not a complete secret/DLP audit. Public extension keys and synthetic fixtures are expected.",
  findings,
};
await writeFile(
  resolve(root, "artifacts/source-audit.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
