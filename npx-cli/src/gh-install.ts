import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import https from "https";

const HOME_DIR = os.homedir();
const GH_BIN_DIR = path.join(HOME_DIR, ".vibe-kanban", "bin");
const GH_STAGING_DIR = path.join(HOME_DIR, ".vibe-kanban", "gh-download");
const SHELL_MARKER = "# vibe-kanban gh cli PATH";

type Arch = "amd64" | "arm64";

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function debug(msg: string): void {
  if (process.env.VIBE_KANBAN_DEBUG) {
    process.stderr.write(`[gh-install] ${msg}\n`);
  }
}

function getGhArch(): Arch {
  const nodeArch = process.arch;
  if (nodeArch === "arm64" || /arm/i.test(nodeArch)) return "arm64";

  if (process.platform === "darwin") {
    try {
      const translated = execSync("sysctl -in sysctl.proc_translated", {
        encoding: "utf8",
      }).trim();
      if (translated === "1") return "arm64";
    } catch {
      // fall through
    }
  }

  if (process.platform === "win32") {
    const pa = process.env.PROCESSOR_ARCHITECTURE || "";
    const paw = process.env.PROCESSOR_ARCHITEW6432 || "";
    if (/arm/i.test(pa) || /arm/i.test(paw)) return "arm64";
  }

  return "amd64";
}

function isGhAvailable(): boolean {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function commandExists(cmd: string): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`where ${cmd}`, { stdio: "ignore" });
    } else {
      execSync(`command -v ${cmd}`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

function addToProcessPath(binDir: string): void {
  const pathVar = process.env.PATH || "";
  const separator = process.platform === "win32" ? ";" : ":";
  const parts = pathVar.split(separator).filter(Boolean);
  if (!parts.includes(binDir)) {
    process.env.PATH = [binDir, ...parts].join(separator);
  }
}

function persistPathUnix(binDir: string): void {
  const shell = process.env.SHELL || "";
  const targets: string[] = [];
  if (/zsh/.test(shell)) {
    targets.push(path.join(HOME_DIR, ".zshrc"));
  } else if (/bash/.test(shell)) {
    targets.push(path.join(HOME_DIR, ".bashrc"));
  } else {
    targets.push(path.join(HOME_DIR, ".profile"));
  }

  const block = `\n${SHELL_MARKER}\nexport PATH="${binDir}:$PATH"\n`;

  for (const target of targets) {
    try {
      let existing = "";
      if (fs.existsSync(target)) {
        existing = fs.readFileSync(target, "utf8");
      }
      if (existing.includes(SHELL_MARKER)) continue;
      fs.appendFileSync(target, block);
      log(`Added gh CLI to PATH in ${target}. Open a new shell to pick it up.`);
    } catch (err: unknown) {
      debug(`Failed to update ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function persistPathWindows(binDir: string): void {
  // Single-quoted PowerShell string: escape ' by doubling it.
  const escaped = binDir.replace(/'/g, "''");
  const script =
    `$dir = '${escaped}'; ` +
    `$current = [Environment]::GetEnvironmentVariable('PATH', 'User'); ` +
    `if (-not $current) { $current = '' }; ` +
    `$parts = @($current -split ';' | Where-Object { $_ }); ` +
    `if ($parts -notcontains $dir) { ` +
    `  $new = (@($parts) + $dir) -join ';'; ` +
    `  [Environment]::SetEnvironmentVariable('PATH', $new, 'User') ` +
    `}`;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: "ignore" },
  );
  if (result.status === 0) {
    log(
      "Added gh CLI to your User PATH. Open a new terminal to pick it up.",
    );
  } else {
    debug(
      `powershell exited with status ${result.status ?? "?"} while updating PATH`,
    );
  }
}

function persistPath(binDir: string): void {
  try {
    if (process.platform === "win32") {
      persistPathWindows(binDir);
    } else {
      persistPathUnix(binDir);
    }
  } catch (err: unknown) {
    debug(
      `Could not persist PATH: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function installViaBrew(): void {
  log("Installing gh via Homebrew...");
  execSync("brew install gh", { stdio: "inherit" });
}

function installViaWinget(): void {
  log("Installing gh via winget...");
  execSync(
    "winget install --id GitHub.cli --silent --accept-source-agreements --accept-package-agreements",
    { stdio: "inherit" },
  );
}

function fetchLatestGhVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        path: "/repos/cli/cli/releases/latest",
        method: "GET",
        headers: {
          "User-Agent": "vibe-kanban-cli",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(
              `GitHub API returned HTTP ${res.statusCode} when fetching latest gh release`,
            ),
          );
          return;
        }
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => {
          try {
            const json = JSON.parse(data) as { tag_name?: string };
            if (!json.tag_name) {
              reject(new Error("GitHub API response missing tag_name"));
              return;
            }
            resolve(json.tag_name.replace(/^v/, ""));
          } catch (err: unknown) {
            reject(
              err instanceof Error
                ? err
                : new Error(`Failed to parse GitHub release JSON: ${String(err)}`),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function downloadFile(url: string, destPath: string): Promise<void> {
  const tempPath = destPath + ".tmp";
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tempPath);
    const cleanup = () => {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    };
    https
      .get(
        url,
        { headers: { "User-Agent": "vibe-kanban-cli" } },
        (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location
          ) {
            file.close();
            cleanup();
            downloadFile(res.headers.location, destPath)
              .then(resolve)
              .catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            file.close();
            cleanup();
            reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            try {
              fs.renameSync(tempPath, destPath);
              resolve();
            } catch (err: unknown) {
              cleanup();
              reject(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          });
        },
      )
      .on("error", (err) => {
        file.close();
        cleanup();
        reject(err);
      });
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
}

function findBinary(dir: string, binName: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === binName) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = findBinary(full, binName);
      if (found) return found;
    }
  }
  return null;
}

async function installFromRelease(): Promise<void> {
  fs.mkdirSync(GH_BIN_DIR, { recursive: true });
  fs.mkdirSync(GH_STAGING_DIR, { recursive: true });

  const version = await fetchLatestGhVersion();
  const platform = process.platform;
  const arch = getGhArch();

  let assetName: string;
  let format: "zip" | "targz";

  if (platform === "darwin") {
    assetName = `gh_${version}_macOS_${arch}.zip`;
    format = "zip";
  } else if (platform === "linux") {
    assetName = `gh_${version}_linux_${arch}.tar.gz`;
    format = "targz";
  } else if (platform === "win32") {
    assetName = `gh_${version}_windows_${arch}.zip`;
    format = "zip";
  } else {
    throw new Error(`Unsupported platform for gh CLI install: ${platform}`);
  }

  const url = `https://github.com/cli/cli/releases/download/v${version}/${assetName}`;
  const archivePath = path.join(GH_STAGING_DIR, assetName);

  log(`Downloading gh CLI v${version} for ${platform}-${arch}...`);
  await downloadFile(url, archivePath);

  const extractDir = path.join(GH_STAGING_DIR, `extract-${version}`);
  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  fs.mkdirSync(extractDir, { recursive: true });

  if (format === "zip") {
    await extractZip(archivePath, extractDir);
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, {
      stdio: "pipe",
    });
  }

  const binName = platform === "win32" ? "gh.exe" : "gh";
  const foundBin = findBinary(extractDir, binName);
  if (!foundBin) {
    throw new Error(
      `gh binary not found inside archive ${assetName} (looked under ${extractDir})`,
    );
  }

  const destBin = path.join(GH_BIN_DIR, binName);
  try {
    fs.rmSync(destBin, { force: true });
  } catch {
    // ignore
  }
  fs.copyFileSync(foundBin, destBin);
  if (platform !== "win32") {
    try {
      fs.chmodSync(destBin, 0o755);
    } catch {
      // ignore
    }
  }

  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(archivePath);
  } catch {
    // ignore
  }

  addToProcessPath(GH_BIN_DIR);
  persistPath(GH_BIN_DIR);
}

async function installGh(): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin" && commandExists("brew")) {
    try {
      installViaBrew();
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`brew install failed (${msg}) — falling back to direct download.`);
    }
  }

  if (platform === "win32" && commandExists("winget")) {
    try {
      installViaWinget();
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`winget install failed (${msg}) — falling back to direct download.`);
    }
  }

  await installFromRelease();
}

export async function ensureGhCli(): Promise<void> {
  // If a previous run installed gh into our fallback dir, make sure it's on
  // PATH so the child server process (and this check below) can find it.
  const binName = process.platform === "win32" ? "gh.exe" : "gh";
  if (fs.existsSync(path.join(GH_BIN_DIR, binName))) {
    addToProcessPath(GH_BIN_DIR);
  }

  if (isGhAvailable()) return;

  log("GitHub CLI (gh) not found — installing before starting vibe-kanban...");

  try {
    await installGh();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Warning: could not install gh CLI automatically: ${msg}`);
    log(
      "Continuing without gh. You can install it later from https://cli.github.com/.",
    );
    return;
  }

  if (isGhAvailable()) {
    log("GitHub CLI installed successfully.");
  } else {
    log(
      "Warning: gh CLI installation ran but the binary is not on PATH for this process. Restart your shell and try again.",
    );
  }
}
