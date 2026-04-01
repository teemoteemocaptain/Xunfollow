#!/usr/bin/env node

import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { DEFAULT_KEYWORDS, evaluateAccount } from "./rules.mjs";
import {
  extractBioFromFollowingRowText,
  extractFollowsYouFromFollowingRowText,
  extractFollowsYouFromProfileText,
  extractLikelyHandleFromHref,
  isLikelyHandle,
  mergeUserSummary,
  profileTextIndicatesNoPosts,
  extractUserSummariesFromApiPayload,
  selectPrimaryHandleFromRow,
  selectLikelyOwnHandleFromAnchors,
} from "./x-helpers.mjs";

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_SCROLLS = "auto";
const DEFAULT_SCROLL_DELAY_MS = 1200;
const DEFAULT_PROFILE_DELAY_MS = 1200;
const DEFAULT_ACTION_DELAY_MS = 1800;
const DEFAULT_ACCOUNT_DELAY_MS = 1500;
const DEFAULT_COLLECT_BATCH_SIZE = 200;
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_BROWSER = "auto";
const DEFAULT_RECYCLE_EVERY = 10;
const DEFAULT_RECOVERY_COOLDOWN_MS = 0;
const DEFAULT_STATE_FILE = ".x-unfollow-state.json";
const DEFAULT_CONFIG_FILE = "x-unfollow.config.json";
const PROFILE_READY_TIMEOUT_MS = 12_000;
const PROFILE_READY_RETRIES = 1;
const TIMELINE_READY_TIMEOUT_MS = 8_000;
const TIMELINE_READY_RETRIES = 1;
const PROFILE_SURFACE_RECOVERY_ATTEMPTS = 1;
const PROFILE_SURFACE_RECOVERY_DELAY_MS = 2_500;
const PROFILE_LOCK_RELEASE_TIMEOUT_MS = 15_000;
const PROFILE_LOCK_RETRY_ATTEMPTS = 8;
const PROFILE_LOCK_RETRY_DELAY_MS = 1_500;
const SESSION_RECOVERY_RETRY_ATTEMPTS = 3;
const SESSION_RECOVERY_RETRY_DELAY_MS = 30_000;
const COLLECTION_RECOVERY_ATTEMPTS = 2;
const COLLECTION_PROGRESS_THROTTLE_MS = 1_500;
const NO_PUBLIC_POSTS_MARKER = "__NO_PUBLIC_POSTS__";
const BLANK_SHELL_EXTENDED_BACKOFF_MS = 10 * 60 * 1000;
const PROFILE_PROCESS_TERMINATION_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

function readCliOptions() {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      browser: { type: "string", default: DEFAULT_BROWSER },
      config: { type: "string" },
      "deep-scan": { type: "boolean", default: false },
      handle: { type: "string" },
      headed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "account-delay-ms": { type: "string", default: String(DEFAULT_ACCOUNT_DELAY_MS) },
      "collect-batch-size": { type: "string", default: String(DEFAULT_COLLECT_BATCH_SIZE) },
      limit: { type: "string", default: String(DEFAULT_LIMIT) },
      "inactive-months": { type: "string", default: "2" },
      keywords: { type: "string", default: DEFAULT_KEYWORDS.join(",") },
      "login-timeout-ms": { type: "string", default: String(DEFAULT_LOGIN_TIMEOUT_MS) },
      report: { type: "string" },
      "recycle-every": { type: "string", default: String(DEFAULT_RECYCLE_EVERY) },
      "recovery-cooldown-ms": { type: "string", default: String(DEFAULT_RECOVERY_COOLDOWN_MS) },
      resume: { type: "boolean", default: false },
      "state-file": { type: "string", default: DEFAULT_STATE_FILE },
      "user-data-dir": { type: "string", default: ".x-session" },
      "max-scrolls": { type: "string", default: DEFAULT_MAX_SCROLLS },
      "scroll-delay-ms": { type: "string", default: String(DEFAULT_SCROLL_DELAY_MS) },
      "profile-delay-ms": { type: "string", default: String(DEFAULT_PROFILE_DELAY_MS) },
      "action-delay-ms": { type: "string", default: String(DEFAULT_ACTION_DELAY_MS) },
    },
    allowPositionals: false,
    strict: true,
  });

  const keywords = String(values.keywords ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    accountDelayMs: parseNonNegativeInteger(values["account-delay-ms"], "account-delay-ms"),
    apply: Boolean(values.apply),
    browser: parseBrowserChoice(values.browser),
    collectBatchSize: parsePositiveInteger(values["collect-batch-size"], "collect-batch-size"),
    config: values.config ? resolve(String(values.config)) : resolve(DEFAULT_CONFIG_FILE),
    deepScan: Boolean(values["deep-scan"]),
    handle: parseHandleOverride(values.handle),
    headed: Boolean(values.headed),
    help: Boolean(values.help),
    limit: parsePositiveInteger(values.limit, "limit"),
    inactiveMonths: parsePositiveInteger(values["inactive-months"], "inactive-months"),
    keywords,
    loginTimeoutMs: parsePositiveInteger(values["login-timeout-ms"], "login-timeout-ms"),
    report: values.report ? resolve(String(values.report)) : defaultReportPath(),
    recycleEvery: parsePositiveInteger(values["recycle-every"], "recycle-every"),
    recoveryCooldownMs: parseNonNegativeInteger(values["recovery-cooldown-ms"], "recovery-cooldown-ms"),
    resume: Boolean(values.resume),
    stateFile: resolve(String(values["state-file"])),
    userDataDir: resolve(String(values["user-data-dir"])),
    maxScrolls: parseMaxScrolls(values["max-scrolls"]),
    scrollDelayMs: parsePositiveInteger(values["scroll-delay-ms"], "scroll-delay-ms"),
    profileDelayMs: parsePositiveInteger(values["profile-delay-ms"], "profile-delay-ms"),
    actionDelayMs: parsePositiveInteger(values["action-delay-ms"], "action-delay-ms"),
  };
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }

  return parsed;
}

function parseMaxScrolls(value) {
  const normalized = String(value ?? DEFAULT_MAX_SCROLLS).trim().toLowerCase();

  if (normalized === "auto") {
    return null;
  }

  return parsePositiveInteger(normalized, "max-scrolls");
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }

  return parsed;
}

function parseBrowserChoice(value) {
  const normalized = String(value ?? DEFAULT_BROWSER).trim().toLowerCase();
  const supported = new Set(["auto", "chrome", "chromium", "msedge"]);

  if (!supported.has(normalized)) {
    throw new Error(`--browser must be one of: ${Array.from(supported).join(", ")}.`);
  }

  return normalized;
}

function parseHandleOverride(value) {
  if (value === undefined) {
    return null;
  }

  const normalized = String(value).trim().replace(/^@/, "");

  if (!isLikelyHandle(normalized)) {
    throw new Error("--handle must be a valid X username, with or without the leading @.");
  }

  return normalized;
}

function defaultReportPath() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  return resolve("reports", `run-${stamp}.json`);
}

function printHelp() {
  console.log(`X unfollow tool

Usage:
  npm start -- [options]

Options:
  --apply                  Actually unfollow matching accounts.
  --account-delay-ms <ms>  Extra delay between deep profile checks. Default: ${DEFAULT_ACCOUNT_DELAY_MS}
  --browser <name>         Browser to use: auto, chrome, chromium, msedge. Default: ${DEFAULT_BROWSER}
  --collect-batch-size <n> Collect this many follows at a time before deep-scanning. Default: ${DEFAULT_COLLECT_BATCH_SIZE}
  --config <path>          JSON config file for policy and defaults. Default: ${DEFAULT_CONFIG_FILE}
  --deep-scan              Visit individual profiles to check inactivity for accounts seed data could not resolve.
  --handle <name>          Manually set your own X handle if profile detection fails.
  --headed                 Launch a visible browser window.
  --limit <number>         Maximum followed accounts to scan. Default: ${DEFAULT_LIMIT}
  --inactive-months <n>    Mark accounts inactive after this many months. Default: 2
  --keywords <list>        Comma-separated profile keywords. Default: ${DEFAULT_KEYWORDS.join(", ")}
  --login-timeout-ms <ms>  How long to wait for manual login in headed mode.
  --report <path>          JSON report output path.
  --recycle-every <n>      Restart the browser session after this many deep profile checks. Default: ${DEFAULT_RECYCLE_EVERY}
  --recovery-cooldown-ms <ms>  Deprecated no-op. Short recovery cooldowns are disabled. Default: ${DEFAULT_RECOVERY_COOLDOWN_MS}
  --resume                 Continue from the last saved state file instead of starting over.
  --state-file <path>      Checkpoint file for long-running deep scans. Default: ${DEFAULT_STATE_FILE}
  --user-data-dir <path>   Persistent Chromium session directory.
  --max-scrolls <number|auto>  Max scroll cycles while loading your following list. Default: ${DEFAULT_MAX_SCROLLS}
  --scroll-delay-ms <ms>   Delay between following-list scrolls.
  --profile-delay-ms <ms>  Delay after profile navigation before inspection.
  --action-delay-ms <ms>   Delay after each unfollow.
  --help, -h               Show this help.

Examples:
  npm start -- --headed
  npm start -- --headed --browser chrome
  npm start -- --headed --handle yourname
  npm start -- --headed --deep-scan --limit 200
  npm start -- --headed --limit 50 --apply
  npm start -- --headed --limit 50 --apply --deep-scan
  npm start -- --keywords "cm,mod,alpha caller" --apply
  npm start -- --config x-unfollow.config.json --headed
`);
}

async function readJsonConfig(path) {
  if (!(await pathExists(path))) {
    return null;
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must contain a JSON object.`);
  }

  return parsed;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

async function applyConfigDefaults(cliOptions) {
  const config = await readJsonConfig(cliOptions.config);

  if (!config) {
    return {
      ...cliOptions,
      keepMutuals: true,
      treatNoPublicPostsAsInactive: true,
      treatHiddenProfilesAsInactive: true,
      allowlistHandles: [],
      configLoaded: false,
    };
  }

  const policy = config.policy && typeof config.policy === "object" ? config.policy : {};
  const defaults = config.defaults && typeof config.defaults === "object" ? config.defaults : {};
  const cliKeywordsExplicit = process.argv.includes("--keywords");
  const cliInactiveExplicit = process.argv.includes("--inactive-months");

  return {
    ...cliOptions,
    inactiveMonths: cliInactiveExplicit
      ? cliOptions.inactiveMonths
      : parsePositiveInteger(defaults.inactiveMonths ?? cliOptions.inactiveMonths, "inactive-months"),
    keywords: cliKeywordsExplicit
      ? cliOptions.keywords
      : normalizeStringArray(policy.keywords, cliOptions.keywords),
    keepMutuals: normalizeBoolean(policy.keepMutuals, true),
    treatNoPublicPostsAsInactive: normalizeBoolean(policy.treatNoPublicPostsAsInactive, true),
    treatHiddenProfilesAsInactive: normalizeBoolean(policy.treatHiddenProfilesAsInactive, true),
    allowlistHandles: normalizeStringArray(policy.allowlistHandles, []).map((handle) =>
      String(handle).replace(/^@/, "").toLowerCase(),
    ),
    configLoaded: true,
  };
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathLexists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserTarget(browserChoice) {
  if (browserChoice === "chrome") {
    return { channel: "chrome", label: "Google Chrome" };
  }

  if (browserChoice === "msedge") {
    return { channel: "msedge", label: "Microsoft Edge" };
  }

  if (browserChoice === "chromium") {
    return { channel: undefined, label: "Playwright Chromium" };
  }

  const chromePaths = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app",
        resolve(homedir(), "Applications/Google Chrome.app"),
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/opt/google/chrome/chrome",
        ];

  for (const candidate of chromePaths) {
    if (await pathExists(candidate)) {
      return { channel: "chrome", label: "Google Chrome" };
    }
  }

  const edgePaths = process.platform === "darwin"
    ? ["/Applications/Microsoft Edge.app"]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : [
          "/usr/bin/microsoft-edge",
          "/opt/microsoft/msedge/msedge",
        ];

  for (const candidate of edgePaths) {
    if (await pathExists(candidate)) {
      return { channel: "msedge", label: "Microsoft Edge" };
    }
  }

  return { channel: undefined, label: "Playwright Chromium" };
}

function getProfileLockPath(userDataDir) {
  return resolve(userDataDir, "SingletonLock");
}

function getProfileCookiePath(userDataDir) {
  return resolve(userDataDir, "SingletonCookie");
}

function getProfileSocketPath(userDataDir) {
  return resolve(userDataDir, "SingletonSocket");
}

function isProfileInUseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("processsingleton")
    || normalized.includes("profile directory")
    || normalized.includes("profile is already in use")
    || normalized.includes("singletonlock")
  );
}

async function waitForProfileLockRelease(userDataDir, timeoutMs = PROFILE_LOCK_RELEASE_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!(await hasChromiumSingletonArtifacts(userDataDir))) {
      return true;
    }

    await sleep(250);
  }

  if (await cleanupStaleChromiumSingletonArtifacts(userDataDir)) {
    return true;
  }

  return !(await hasChromiumSingletonArtifacts(userDataDir));
}

async function hasChromiumSingletonArtifacts(userDataDir) {
  return (
    await pathLexists(getProfileLockPath(userDataDir))
    || await pathLexists(getProfileCookiePath(userDataDir))
    || await pathLexists(getProfileSocketPath(userDataDir))
  );
}

async function readSingletonSocketTarget(userDataDir) {
  const socketPath = getProfileSocketPath(userDataDir);

  if (!(await pathLexists(socketPath))) {
    return null;
  }

  try {
    const target = await readlink(socketPath);
    return isAbsolute(target) ? target : resolve(dirname(socketPath), target);
  } catch {
    return socketPath;
  }
}

async function singletonSocketLooksAlive(userDataDir) {
  const socketTarget = await readSingletonSocketTarget(userDataDir);

  if (!socketTarget) {
    return false;
  }

  return new Promise((resolvePromise) => {
    const socket = net.createConnection(socketTarget);
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(value);
    };

    socket.setTimeout(800);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function cleanupStaleChromiumSingletonArtifacts(userDataDir) {
  if ((await listChromiumProfileProcessIds(userDataDir)).length > 0) {
    return false;
  }

  if (await singletonSocketLooksAlive(userDataDir)) {
    return false;
  }

  const singletonPaths = [
    getProfileLockPath(userDataDir),
    getProfileCookiePath(userDataDir),
    getProfileSocketPath(userDataDir),
  ];

  let removedAny = false;

  for (const singletonPath of singletonPaths) {
    if (!(await pathLexists(singletonPath))) {
      continue;
    }

    await unlink(singletonPath).catch(() => {});
    removedAny = true;
  }

  if (removedAny) {
    console.warn("Detected stale Chromium singleton files in the saved session profile. Cleaning them up before retrying the browser launch.");
  }

  return removedAny;
}

async function listChromiumProfileProcessIds(userDataDir) {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "--", `--user-data-dir=${userDataDir}`]);

    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch (error) {
    const exitCode = error && typeof error === "object" && "code" in error
      ? Number(error.code)
      : NaN;

    if (exitCode === 1) {
      return [];
    }

    return [];
  }
}

function tryKillProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function formatPidList(pids) {
  return pids.join(", ");
}

async function terminateChromiumProfileProcesses(userDataDir) {
  const initialPids = await listChromiumProfileProcessIds(userDataDir);

  if (initialPids.length === 0) {
    return false;
  }

  console.warn(
    `Chrome processes for the saved session are still alive after close (${formatPidList(initialPids)}). Terminating them before retrying recovery.`,
  );

  const termFailedPids = [];
  for (const pid of initialPids) {
    if (!tryKillProcess(pid, "SIGTERM")) {
      termFailedPids.push(pid);
    }
  }

  if (termFailedPids.length > 0) {
    console.warn(
      `Some saved-session Chrome processes could not be sent SIGTERM (${formatPidList(termFailedPids)}).`,
    );
  }

  const terminationDeadline = Date.now() + PROFILE_PROCESS_TERMINATION_TIMEOUT_MS;

  while (Date.now() < terminationDeadline) {
    if ((await listChromiumProfileProcessIds(userDataDir)).length === 0) {
      return true;
    }

    await sleep(250);
  }

  const remainingPids = await listChromiumProfileProcessIds(userDataDir);

  if (remainingPids.length > 0) {
    console.warn(
      `Saved-session Chrome processes still alive after SIGTERM (${formatPidList(remainingPids)}). Escalating to SIGKILL.`,
    );
  }

  const killFailedPids = [];
  for (const pid of remainingPids) {
    if (!tryKillProcess(pid, "SIGKILL")) {
      killFailedPids.push(pid);
    }
  }

  if (killFailedPids.length > 0) {
    console.warn(
      `Some saved-session Chrome processes could not be sent SIGKILL (${formatPidList(killFailedPids)}).`,
    );
  }

  const killDeadline = Date.now() + PROFILE_PROCESS_TERMINATION_TIMEOUT_MS;

  while (Date.now() < killDeadline) {
    if ((await listChromiumProfileProcessIds(userDataDir)).length === 0) {
      return true;
    }

    await sleep(250);
  }

  const survivingPids = await listChromiumProfileProcessIds(userDataDir);

  if (survivingPids.length > 0) {
    console.warn(
      `Saved-session Chrome processes are still alive even after SIGKILL (${formatPidList(survivingPids)}).`,
    );
    return false;
  }

  return true;
}

async function launchBrowserContext(options) {
  const preferred = await resolveBrowserTarget(options.browser);
  const attempts = preferred.channel
    ? [preferred, { channel: undefined, label: "Playwright Chromium" }]
    : [preferred];

  let lastError = null;

  for (const target of attempts) {
    for (let attempt = 1; attempt <= PROFILE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await sleep(PROFILE_LOCK_RETRY_DELAY_MS);
      }

      await waitForProfileLockRelease(options.userDataDir).catch(() => false);

      try {
        const context = await chromium.launchPersistentContext(options.userDataDir, {
          channel: target.channel,
          headless: !options.headed,
          viewport: options.headed ? null : { width: 1440, height: 1200 },
          colorScheme: "dark",
          args: [
            "--disable-blink-features=AutomationControlled",
            "--hide-crash-restore-bubble",
            ...(options.headed ? ["--start-maximized"] : []),
          ],
        });

        await context.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
        });

        return { context, browserLabel: target.label };
      } catch (error) {
        lastError = error;

        if (!isProfileInUseError(error)) {
          break;
        }

        await terminateChromiumProfileProcesses(options.userDataDir).catch(() => false);

        if (attempt === PROFILE_LOCK_RETRY_ATTEMPTS) {
          throw error;
        }

        console.warn(
          `The saved browser profile is still locked by Chromium. Waiting ${Math.ceil(PROFILE_LOCK_RETRY_DELAY_MS / 1000)}s and retrying the session launch (${attempt}/${PROFILE_LOCK_RETRY_ATTEMPTS}).`,
        );
      }
    }
  }

  throw lastError;
}

function configurePage(page) {
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
}

async function createBrowserSession(options) {
  const { context, browserLabel } = await launchBrowserContext(options);
  const page = context.pages()[0] ?? (await context.newPage());
  configurePage(page);
  return {
    context,
    page,
    browserLabel,
    uiPage: null,
    workerPage: null,
    userDataDir: options.userDataDir,
  };
}

async function closeBrowserSession(session) {
  if (!session?.context) {
    return;
  }

  try {
    await session.context.close();
  } catch {
    // Ignore close errors during recovery or shutdown.
  }

  if (session.userDataDir) {
    let released = await waitForProfileLockRelease(session.userDataDir).catch(() => false);

    if (!released) {
      const terminated = await terminateChromiumProfileProcesses(session.userDataDir).catch(() => false);
      released = await waitForProfileLockRelease(session.userDataDir).catch(() => false);

      if (!released && !terminated) {
        console.warn("The saved browser profile still looks in use after forced Chrome process cleanup.");
      }
    }
  }
}

function isRecoverableSessionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return [
    "target page, context or browser has been closed",
    "browser has been closed",
    "page was closed",
    "page crashed",
    "browser disconnected",
    "x app shell got stuck",
    "x kept returning 'something went wrong'",
    "x did not render a usable profile",
    "timed out while opening your following page",
    "timed out while reopening your following page",
  ].some((pattern) => normalized.includes(pattern));
}

function isGotoTimeoutError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return normalized.includes("page.goto") && normalized.includes("timeout");
}

async function sleep(ms) {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pageLooksLikeBlankXShell(page) {
  const state = await readProfilePageState(page, "");
  return Boolean(state?.looksShellStuck);
}

async function resetXClientState(page, options) {
  console.warn("X reopened into a blank app shell. Clearing X client-side app data while keeping cookies, then reloading once.");

  await page.evaluate(async () => {
    try {
      window.localStorage?.clear();
    } catch {
      // Ignore storage access errors.
    }

    try {
      window.sessionStorage?.clear();
    } catch {
      // Ignore storage access errors.
    }

    try {
      if ("caches" in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      }
    } catch {
      // Ignore cache-storage errors.
    }

    try {
      const registrations = navigator.serviceWorker
        ? await navigator.serviceWorker.getRegistrations()
        : [];
      await Promise.all(registrations.map((registration) =>
        registration.unregister().catch(() => false),
      ));
    } catch {
      // Ignore service-worker errors.
    }

    try {
      if (typeof indexedDB?.databases === "function") {
        const databases = await indexedDB.databases();
        await Promise.all(
          databases
            .map((database) => database?.name)
            .filter(Boolean)
            .map((name) => new Promise((resolve) => {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = () => resolve(true);
              request.onerror = () => resolve(false);
              request.onblocked = () => resolve(false);
            })),
        );
      }
    } catch {
      // Ignore IndexedDB cleanup errors.
    }
  }).catch(() => {});

  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(Math.max(1500, Math.min(options.profileDelayMs, 5000))).catch(() => {});
}

async function reopenSessionAfterBlankShellBackoff(options, session, reason) {
  await closeBrowserSession(session);
  console.warn(
    `X still looks rate-limited and only renders the blank app shell. Closing the browser for ${Math.ceil(BLANK_SHELL_EXTENDED_BACKOFF_MS / 1000)}s before retrying the saved session.`,
  );
  await sleep(BLANK_SHELL_EXTENDED_BACKOFF_MS);

  const nextSession = await createBrowserSession(options);
  console.warn(`${reason}. Reopening the saved session after the extended blank-shell cooldown.`);
  console.log(`Using ${nextSession.browserLabel} with session dir ${options.userDataDir}`);
  await ensureLoggedIn(nextSession.page, options);
  return nextSession;
}

async function recoverBrowserSession(options, previousSession, recovery = {}) {
  const {
    reason = "Recovery",
  } = recovery;

  await closeBrowserSession(previousSession);

  let nextSession = await createBrowserSession(options);
  console.warn(`${reason}. Reopening the saved session and continuing.`);
  console.log(`Using ${nextSession.browserLabel} with session dir ${options.userDataDir}`);
  await ensureLoggedIn(nextSession.page, options);

  if (await pageLooksLikeBlankXShell(nextSession.page)) {
    await resetXClientState(nextSession.page, options);

    if (await pageLooksLikeBlankXShell(nextSession.page)) {
      nextSession = await reopenSessionAfterBlankShellBackoff(
        options,
        nextSession,
        reason,
      );

      if (await pageLooksLikeBlankXShell(nextSession.page)) {
        await resetXClientState(nextSession.page, options);
      }

      if (await pageLooksLikeBlankXShell(nextSession.page)) {
        throw new Error("X app shell got stuck again after reopening, resetting X client-side app data, and waiting through the extended cooldown.");
      }
    }
  }

  nextSession = await initializeDashboardSession(nextSession, options);
  if (previousSession?.workerPage || options.deepScan) {
    nextSession = await ensureWorkerPage(nextSession);
  }

  return nextSession;
}

async function recoverBrowserSessionWithRetry(options, previousSession, recovery = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= SESSION_RECOVERY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await recoverBrowserSession(options, previousSession, recovery);
    } catch (error) {
      lastError = error;

      if (!isProfileInUseError(error) || attempt === SESSION_RECOVERY_RETRY_ATTEMPTS) {
        throw error;
      }

      console.warn(
        `Chromium still has the saved profile locked after recovery. Waiting ${Math.ceil(SESSION_RECOVERY_RETRY_DELAY_MS / 1000)}s and retrying the browser recovery (${attempt}/${SESSION_RECOVERY_RETRY_ATTEMPTS}).`,
      );
      await sleep(SESSION_RECOVERY_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function ensureWorkerPage(session) {
  if (session.workerPage && !session.workerPage.isClosed()) {
    return session;
  }

  const workerPage = await session.context.newPage();
  configurePage(workerPage);
  return { ...session, workerPage };
}

function getInspectionPage(session) {
  return session.workerPage ?? session.page;
}

function isSessionUsable(session) {
  if (!session?.context || !session?.page || session.page.isClosed()) {
    return false;
  }

  const inspectionPage = getInspectionPage(session);
  return Boolean(inspectionPage) && !inspectionPage.isClosed();
}

async function bringPageToFront(page) {
  if (!page) {
    return;
  }

  await page.bringToFront().catch(() => {});
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderProgressHtml({
  ownHandle = "",
  phase = "Preparing scan",
  currentHandle = "",
  scanned = 0,
  total = 0,
  matched = 0,
  unresolved = 0,
  recoveries = 0,
  apply = false,
  deepScan = false,
}) {
  const modeLabel = apply
    ? "Live unfollow mode"
    : deepScan
      ? "Deep dry run"
      : "Fast dry run";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>X Unfollow Tool Progress</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101416;
      --panel: #171d20;
      --text: #f2efe7;
      --muted: #9da8af;
      --line: #2b353b;
      --accent: #ff7a45;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(216, 91, 51, 0.15), transparent 35%),
        linear-gradient(160deg, var(--bg), #efe1cf);
      color: var(--text);
      padding: 32px;
    }
    .wrap {
      max-width: 820px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 14px 40px rgba(31, 27, 22, 0.08);
    }
    .eyebrow {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--accent);
      margin-bottom: 8px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 34px;
      line-height: 1.05;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.5;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      background: rgba(255, 255, 255, 0.03);
    }
    .stat strong {
      display: block;
      font-size: 28px;
      line-height: 1;
      margin-bottom: 8px;
    }
    .stat span {
      color: var(--muted);
      font-size: 13px;
    }
    .now {
      font-size: 18px;
      margin-top: 10px;
    }
    code {
      font-family: "SF Mono", "Menlo", monospace;
      background: rgba(255, 122, 69, 0.14);
      padding: 2px 6px;
      border-radius: 6px;
    }
    @media (max-width: 720px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="panel">
      <div class="eyebrow">X Unfollow Tool</div>
      <h1>${escapeHtml(modeLabel)}</h1>
      <p>Scanning <code>@${escapeHtml(ownHandle || "unknown")}</code> while keeping this tab as a progress view.</p>
      <p class="now">Phase: <strong>${escapeHtml(phase)}</strong>${currentHandle ? ` for <code>@${escapeHtml(currentHandle)}</code>` : ""}</p>
    </section>
    <section class="stats">
      <div class="stat"><strong>${scanned}</strong><span>Accounts finished</span></div>
      <div class="stat"><strong>${matched}</strong><span>Matched filters</span></div>
      <div class="stat"><strong>${unresolved}</strong><span>Skipped deep profile checks</span></div>
      <div class="stat"><strong>${recoveries}</strong><span>Session recoveries</span></div>
    </section>
    <section class="panel">
      <p>Total queued so far: <code>${total}</code></p>
      <p>${apply ? "This run can unfollow matches." : deepScan ? "This dry run is visiting full profiles when seed data is incomplete." : "This fast dry run uses following-list data and avoids slow profile-by-profile lookups unless you rerun with --deep-scan."}</p>
    </section>
  </div>
</body>
</html>`;
}

async function updateProgressDashboard(session, progress) {
  if (!session?.uiPage) {
    return;
  }

  try {
    await session.uiPage.setContent(renderProgressHtml(progress), {
      waitUntil: "domcontentloaded",
    });
  } catch {
    // Ignore dashboard rendering issues and keep the worker running.
  }
}

async function initializeDashboardSession(session, options) {
  if (!options.headed || session.uiPage) {
    return session;
  }

  const uiPage = await session.context.newPage();
  configurePage(uiPage);
  await uiPage.setContent(renderProgressHtml({}), {
    waitUntil: "domcontentloaded",
  }).catch(() => {});
  return { ...session, uiPage };
}

async function ensureLoggedIn(page, options) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });

  const startedAt = Date.now();
  const timeoutMs = options.headed ? options.loginTimeoutMs : 20 * 1000;
  let loginHintShown = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (await isLoggedIn(page)) {
      return;
    }

    if (!options.headed && isLoginUrl(page.url())) {
      throw new Error("X login is required. Re-run with --headed so you can sign in manually.");
    }

    if (options.headed && !loginHintShown) {
      console.log(
        `Login required in the opened browser. This tool saves its own session in ${options.userDataDir}, so your regular Chrome login is not reused until you sign in once here.`,
      );
      loginHintShown = true;

      if (!isLoginUrl(page.url())) {
        await page.goto("https://x.com/i/flow/login", {
          waitUntil: "domcontentloaded",
        }).catch(() => {});
      }
    }

    await page.waitForTimeout(1500);
  }

  if (options.headed) {
    throw new Error("Timed out waiting for X login. Finish the login flow in the opened browser and try again.");
  }

  throw new Error("Could not confirm an active X session. Re-run with --headed for interactive login.");
}

async function isLoggedIn(page) {
  if (await looksLoggedOut(page)) {
    return false;
  }

  try {
    const cookies = await page.context().cookies("https://x.com");
    if (cookies.some((cookie) => cookie.name === "auth_token" || cookie.name === "twid")) {
      return true;
    }
  } catch {
    // Fall back to UI checks if cookie inspection is unavailable.
  }

  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first();
  const homeLink = page.locator('a[data-testid="AppTabBar_Home_Link"]').first();

  try {
    return (
      await profileLink.isVisible({ timeout: 1500 }).catch(() => false)
    ) || (
      await homeLink.isVisible({ timeout: 1500 }).catch(() => false)
    );
  } catch {
    return false;
  }
}

function isLoginUrl(url) {
  return url.includes("/login") || url.includes("/i/flow/login");
}

async function looksLoggedOut(page) {
  const url = page.url();

  if (isLoginUrl(url)) {
    return true;
  }

  return page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() ?? "";

    if (text.includes("sign in") && text.includes("create account")) {
      return true;
    }

    const loginishLabels = Array.from(document.querySelectorAll("a, button"))
      .slice(0, 150)
      .map((element) => (element.textContent ?? "").trim().toLowerCase());

    return loginishLabels.includes("sign in") || loginishLabels.includes("log in");
  }).catch(() => false);
}

async function describeSessionState(page) {
  const hasAuthCookies = await page.context()
    .cookies("https://x.com")
    .then((cookies) => cookies.some((cookie) => cookie.name === "auth_token" || cookie.name === "twid"))
    .catch(() => false);

  const pageDetails = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll('nav a[href^="/"], header a[href^="/"], aside a[href^="/"], a[href^="/"]'),
    )
      .slice(0, 30)
      .map((anchor) => ({
        href: anchor.getAttribute("href"),
        text: (anchor.textContent ?? "").trim(),
        ariaLabel: anchor.getAttribute("aria-label"),
        dataTestId: anchor.getAttribute("data-testid"),
      }));

    return {
      title: document.title,
      mainTextSnippet: (document.querySelector("main")?.innerText ?? document.body?.innerText ?? "")
        .slice(0, 400),
      anchors,
    };
  }).catch(() => ({
    title: "",
    mainTextSnippet: "",
    anchors: [],
  }));

  return {
    url: page.url(),
    hasAuthCookies,
    ...pageDetails,
  };
}

async function getOwnHandle(page, options) {
  if (options.handle) {
    return options.handle;
  }

  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]').first();
  const href = await profileLink.getAttribute("href").catch(() => null);
  const directHandle = extractLikelyHandleFromHref(href);

  if (directHandle) {
    return directHandle;
  }

  const fallbackHandle = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll(
        'nav a[href^="/"], header a[href^="/"], aside a[href^="/"], a[href^="/"]',
      ),
    )
      .slice(0, 250)
      .map((anchor) => ({
        href: anchor.getAttribute("href"),
        text: anchor.textContent,
        ariaLabel: anchor.getAttribute("aria-label"),
        title: anchor.getAttribute("title"),
        dataTestId: anchor.getAttribute("data-testid"),
      }));

    return anchors;
  }).then((anchors) => selectLikelyOwnHandleFromAnchors(anchors));

  if (!fallbackHandle) {
    const sessionState = await describeSessionState(page);
    const loggedOut = await looksLoggedOut(page);
    const baseMessage = loggedOut
      ? "Your X session looks logged out or expired."
      : "Could not determine your X handle from the current X page.";

    throw new Error(
      `${baseMessage} Try logging in again, or pass --handle your_username. Current URL: ${sessionState.url || "unknown"}`,
    );
  }

  return fallbackHandle;
}

function pickPrimaryBio(primaryBio, fallbackBio) {
  return primaryBio || fallbackBio || "";
}

function pickKnownLatestPostAt(primaryLatestPostAt, fallbackLatestPostAt) {
  return primaryLatestPostAt ?? fallbackLatestPostAt ?? null;
}

function normalizeHandleKey(handle) {
  return String(handle ?? "").trim().toLowerCase();
}

function normalizeStoredRunConfig(config = {}) {
  return {
    apply: Boolean(config.apply),
    deepScan: Boolean(config.deepScan),
    inactiveMonths: Number.parseInt(String(config.inactiveMonths ?? 2), 10),
    keywords: normalizeStringArray(config.keywords, DEFAULT_KEYWORDS),
    keepMutuals: normalizeBoolean(config.keepMutuals, true),
    treatNoPublicPostsAsInactive: normalizeBoolean(config.treatNoPublicPostsAsInactive, true),
    treatHiddenProfilesAsInactive: normalizeBoolean(config.treatHiddenProfilesAsInactive, true),
    allowlistHandles: normalizeStringArray(config.allowlistHandles, []).map((handle) =>
      String(handle).replace(/^@/, "").toLowerCase(),
    ),
  };
}

function getCurrentRunConfig(options) {
  return normalizeStoredRunConfig({
    apply: options.apply,
    deepScan: options.deepScan,
    inactiveMonths: options.inactiveMonths,
    keywords: options.keywords,
    keepMutuals: options.keepMutuals,
    treatNoPublicPostsAsInactive: options.treatNoPublicPostsAsInactive,
    treatHiddenProfilesAsInactive: options.treatHiddenProfilesAsInactive,
    allowlistHandles: options.allowlistHandles,
  });
}

function runConfigsMatch(savedConfig, currentConfig) {
  return JSON.stringify(normalizeStoredRunConfig(savedConfig)) === JSON.stringify(normalizeStoredRunConfig(currentConfig));
}

function isAllowlistedHandle(handle, options) {
  const handleKey = normalizeHandleKey(handle);
  return Boolean(handleKey) && Array.isArray(options.allowlistHandles) && options.allowlistHandles.includes(handleKey);
}

function buildCollectionFrontierHandles(followingHandles, maxCount = 25) {
  const frontier = [];
  const seen = new Set();

  for (let index = (followingHandles?.length ?? 0) - 1; index >= 0; index -= 1) {
    const key = normalizeHandleKey(followingHandles[index]);

    if (!key || seen.has(key)) {
      continue;
    }

    frontier.push(key);
    seen.add(key);

    if (frontier.length >= maxCount) {
      break;
    }
  }

  return frontier;
}

function isResultCacheable(result, options = {}) {
  if (!result?.handle) {
    return false;
  }

  if (result.action === "error") {
    return false;
  }

  if (result.action === "would-unfollow" && options.apply) {
    return false;
  }

  if (result.action === "skipped") {
    const note = String(result.note ?? "").toLowerCase();
    return (
      note.includes("does not exist")
      || note.includes("suspended")
      || note.includes("no longer appear to be following")
    );
  }

  return true;
}

function upsertResult(results, nextResult) {
  const key = normalizeHandleKey(nextResult?.handle);

  if (!key) {
    return results;
  }

  const existingIndex = results.findIndex((result) => normalizeHandleKey(result?.handle) === key);

  if (existingIndex === -1) {
    results.push(nextResult);
  } else {
    results[existingIndex] = nextResult;
  }

  return results;
}

function dedupeResults(results) {
  const deduped = [];

  for (const result of results ?? []) {
    upsertResult(deduped, result);
  }

  return deduped;
}

function buildResultCache(results, options = {}) {
  const cache = new Map();

  for (const result of results ?? []) {
    const key = normalizeHandleKey(result?.handle);

    if (!key || cache.has(key) || !isResultCacheable(result, options)) {
      continue;
    }

    cache.set(key, result);
  }

  return cache;
}

function findNextUncheckedHandle(followingHandles, resultCache, deferredHandleKeys = new Set()) {
  return followingHandles.find((handle) => {
    const key = normalizeHandleKey(handle);
    return key && !resultCache.has(key) && !deferredHandleKeys.has(key);
  }) ?? null;
}

function countProcessedHandles(resultCache, deferredHandleKeys = new Set()) {
  return resultCache.size + deferredHandleKeys.size;
}

async function waitBetweenDeepProfileChecks(page, delayMs) {
  if (delayMs <= 0) {
    return;
  }

  const jitter = Math.floor(delayMs * 0.2);
  const minimum = Math.max(0, delayMs - jitter);
  const maximum = delayMs + jitter;
  const actualDelay = minimum + Math.floor(Math.random() * Math.max(1, maximum - minimum + 1));
  await sleep(actualDelay);
}

function buildAccountResult({
  handle,
  profileUrl,
  action,
  bio,
  evaluation,
  note = null,
}) {
  const reasons = [];

  if (!evaluation.followsYou && evaluation.keywordMatches.length > 0) {
    reasons.push(`bio matched: ${evaluation.keywordMatches.join(", ")}`);
  }

  if (!evaluation.followsYou && evaluation.hasNoPublicPosts) {
    reasons.push("profile has no public posts");
  } else if (!evaluation.followsYou && evaluation.inactiveMatch) {
    reasons.push(
      `latest visible post ${evaluation.ageDays} days ago (${evaluation.latestPostAt})`,
    );
  }

  let resolvedNote = note;

  if (!resolvedNote && evaluation.followsYou) {
    resolvedNote = "Account follows you, so it was kept.";
  } else if (!resolvedNote && evaluation.allowlisted) {
    resolvedNote = "Account is on the allowlist, so it was kept.";
  } else if (
    !resolvedNote
    && !evaluation.hasKnownActivity
    && !evaluation.hasNoPublicPosts
    && evaluation.keywordMatches.length === 0
  ) {
    resolvedNote = "No visible public post date found, so inactivity could not be confirmed.";
  }

  return {
    handle,
    profileUrl,
    action,
    shouldUnfollow: evaluation.shouldUnfollow,
    reasons,
    note: resolvedNote,
    bio,
    followsYou: evaluation.followsYou,
    latestPostAt: evaluation.latestPostAt,
    hasNoPublicPosts: evaluation.hasNoPublicPosts,
    keywordMatches: evaluation.keywordMatches,
    ageDays: evaluation.ageDays,
  };
}

function shouldResolveFromSeedData(seedData, evaluation, apply) {
  if (!seedData || apply) {
    return false;
  }

  if (evaluation.shouldUnfollow) {
    return true;
  }

  return seedData.bioKnown && seedData.latestPostKnown;
}

function shouldSkipDeepProfileCheck(options, seedData, evaluation) {
  if (options.apply || options.deepScan) {
    return false;
  }

  if (evaluation.shouldUnfollow) {
    return true;
  }

  if (!seedData) {
    return true;
  }

  return !seedData.bioKnown || !seedData.latestPostKnown;
}

function getGraphqlOperationName(url) {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  } catch {
    return "";
  }
}

function isFollowingGraphqlOperation(url) {
  const operationName = getGraphqlOperationName(url).toLowerCase();

  if (!operationName) {
    return false;
  }

  return operationName.includes("following") || operationName.includes("friends");
}

async function readFollowingPageState(page) {
  return page.evaluate(() => {
    const mainText = document.querySelector("main")?.innerText ?? "";
    const normalizedText = mainText.toLowerCase();

    return {
      currentUrl: window.location.href,
      hasError: normalizedText.includes("something went wrong. try reloading")
        || normalizedText.includes("something went wrong try reloading"),
      userCellCount: document.querySelectorAll('div[data-testid="UserCell"]').length,
      cellInnerCount: document.querySelectorAll('div[data-testid="cellInnerDiv"]').length,
      retryButtonVisible: Array.from(document.querySelectorAll("button")).some((button) =>
        (button.textContent ?? "").trim().toLowerCase() === "retry",
      ),
      mainTextSnippet: mainText.slice(0, 500),
    };
  });
}

function isFollowingUrl(currentUrl, ownHandle, followingUrl) {
  try {
    const current = new URL(currentUrl);
    const expected = new URL(followingUrl);
    const normalizedHandle = ownHandle.toLowerCase();

    if (current.origin !== expected.origin) {
      return false;
    }

    const path = current.pathname.toLowerCase().replace(/\/+$/, "");
    const expectedPath = `/${normalizedHandle}/following`;

    return path === expectedPath;
  } catch {
    return false;
  }
}

async function recoverFollowingPage(page, followingUrl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readFollowingPageState(page);

    if (await pageLooksLikeBlankXShell(page)) {
      throw new Error("X app shell got stuck on your Following page.");
    }

    if (!state.hasError) {
      return state;
    }

    console.warn(`X returned an error on the Following page. Retry attempt ${attempt + 1}/3.`);

    const retryButton = page.getByRole("button", { name: /^Retry$/i }).first();
    const clickedRetry = await retryButton.isVisible({ timeout: 1000 })
      .then(async (visible) => {
        if (!visible) {
          return false;
        }

        await retryButton.click();
        return true;
      })
      .catch(() => false);

    if (!clickedRetry) {
      try {
        await page.goto(followingUrl, { waitUntil: "domcontentloaded" });
      } catch (error) {
        if (isGotoTimeoutError(error)) {
          throw new Error("X timed out while reopening your Following page.");
        }

        throw error;
      }
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500);
  }

  return readFollowingPageState(page);
}

async function ensureFollowingPage(page, ownHandle, followingUrl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readFollowingPageState(page);

    if (isFollowingUrl(state.currentUrl, ownHandle, followingUrl)) {
      return state;
    }

    console.warn(
      `X did not stay on your Following page (currently ${state.currentUrl || "unknown"}). Retrying navigation ${attempt + 1}/3.`,
    );

    try {
      await page.goto(followingUrl, { waitUntil: "domcontentloaded" });
    } catch (error) {
      if (isGotoTimeoutError(error)) {
        throw new Error("X timed out while reopening your Following page.");
      }

      throw error;
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);
  }

  return readFollowingPageState(page);
}

async function advanceFollowingList(page, scrollDelayMs) {
  const rowLocator = page.locator(
    'main div[data-testid="UserCell"], main div[data-testid="cellInnerDiv"]',
  );

  try {
    const rowCount = await rowLocator.count();

    if (rowCount > 0) {
      await rowLocator.nth(rowCount - 1).scrollIntoViewIfNeeded().catch(() => {});
    }
  } catch {
    // Fall through to generic scrolling if the row locator is unstable.
  }

  await page.mouse.wheel(0, 2800).catch(() => {});
  await page.evaluate(() => {
    window.scrollBy(0, window.innerHeight * 0.95);

    const main = document.querySelector("main");
    if (main instanceof HTMLElement) {
      main.scrollTop += main.clientHeight;
    }
  }).catch(() => {});
  await page.keyboard.press("PageDown").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(scrollDelayMs);
}

async function advanceFollowingListQuick(page, scrollDelayMs) {
  const rowLocator = page.locator(
    'main div[data-testid="UserCell"], main div[data-testid="cellInnerDiv"]',
  );

  try {
    const rowCount = await rowLocator.count();

    if (rowCount > 0) {
      await rowLocator.nth(rowCount - 1).scrollIntoViewIfNeeded().catch(() => {});
    }
  } catch {
    // Fall through to generic scrolling if the row locator is unstable.
  }

  await page.mouse.wheel(0, 3600).catch(() => {});
  await page.evaluate(() => {
    window.scrollBy(0, window.innerHeight * 1.25);

    const main = document.querySelector("main");
    if (main instanceof HTMLElement) {
      main.scrollTop += main.clientHeight * 1.25;
    }
  }).catch(() => {});
  await page.keyboard.press("PageDown").catch(() => {});
  await page.waitForTimeout(Math.max(250, Math.min(scrollDelayMs, 450)));
}

async function readVisibleFollowingRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll(
        'main div[data-testid="UserCell"], main div[data-testid="cellInnerDiv"]',
      ),
    );

    if (rows.length > 0) {
      return rows.map((row) => ({
        text: row.textContent ?? "",
        hrefs: Array.from(row.querySelectorAll('a[href^="/"]'))
          .map((anchor) => anchor.getAttribute("href"))
          .filter(Boolean),
      }));
    }

    return Array.from(document.querySelectorAll('main a[href^="/"]')).map((anchor) => ({
      text: anchor.textContent ?? "",
      hrefs: [anchor.getAttribute("href")].filter(Boolean),
    }));
  });
}

function mergeVisibleFollowingRowsIntoDomUsers(rows, domUsers, ownHandle) {
  const visibleHandleKeys = new Set();

  for (const row of rows) {
    const primaryHandle = selectPrimaryHandleFromRow(row.hrefs, row.text, ownHandle);

    if (!primaryHandle) {
      continue;
    }

    const normalizedPrimaryHandle = normalizeHandleKey(primaryHandle);
    visibleHandleKeys.add(normalizedPrimaryHandle);

    const bio = extractBioFromFollowingRowText(row.text, primaryHandle);
    const followsYou = extractFollowsYouFromFollowingRowText(row.text);
    domUsers.set(
      primaryHandle,
      mergeUserSummary(domUsers.get(primaryHandle), {
        handle: primaryHandle,
        bioKnown: bio.length > 0,
        bio,
        followsYouKnown: true,
        followsYou,
        latestPostKnown: false,
        latestPostAt: null,
      }),
    );
  }

  return visibleHandleKeys;
}

function resolveMaxScrolls(limit, configuredMaxScrolls) {
  if (Number.isInteger(configuredMaxScrolls) && configuredMaxScrolls > 0) {
    return configuredMaxScrolls;
  }

  // X's lazy-loading rate varies a lot, so use a generous ceiling and rely on
  // idle-pass detection to stop early once no new follows appear.
  return Math.max(40, Math.min(1200, Math.ceil(limit / 6)));
}

async function collectFollowingHandles(
  page,
  ownHandle,
  limit,
  maxScrolls,
  scrollDelayMs,
  existingSeedDataByHandle = new Map(),
  continueFromCurrent = false,
  onProgress = null,
  knownFollowingHandles = [],
) {
  const followingUrl = `https://x.com/${ownHandle}/following`;
  const resolvedMaxScrolls = resolveMaxScrolls(limit, maxScrolls);
  const networkUsers = new Map(existingSeedDataByHandle.entries());
  const domUsers = new Map(existingSeedDataByHandle.entries());
  const knownFrontierHandles = buildCollectionFrontierHandles(knownFollowingHandles);
  let followingResponseCount = 0;
  let lastReportedQueued = -1;
  let lastReportedScroll = 0;
  let lastReportedIdlePasses = -1;
  let navigatedToFollowingPage = false;

  const reportProgress = async ({
    queued,
    scrollCount,
    idlePasses,
    rowCount,
    done = false,
  }) => {
    if (!onProgress) {
      return;
    }

    const shouldReport = (
      done
      || scrollCount <= 1
      || queued - lastReportedQueued >= 10
      || scrollCount - lastReportedScroll >= 10
      || idlePasses !== lastReportedIdlePasses
    );

    if (!shouldReport) {
      return;
    }

    lastReportedQueued = queued;
    lastReportedScroll = scrollCount;
    lastReportedIdlePasses = idlePasses;

    void Promise.resolve(onProgress({
      queued,
      limit,
      scrollCount,
      maxScrolls: resolvedMaxScrolls,
      idlePasses,
      rowCount,
      responseCount: followingResponseCount,
      done,
    })).catch(() => {});
  };

  const onResponse = async (response) => {
    const url = response.url();

    if (!url.includes("/i/api/graphql/")) {
      return;
    }

    if (!isFollowingGraphqlOperation(url)) {
      return;
    }

    if (!response.ok()) {
      return;
    }

    try {
      followingResponseCount += 1;
      const payload = await response.json();
      const userSummaries = extractUserSummariesFromApiPayload(payload);

      for (const summary of userSummaries) {
        if (summary.handle !== ownHandle) {
          networkUsers.set(
            summary.handle,
            mergeUserSummary(networkUsers.get(summary.handle), summary),
          );
        }
      }
    } catch {
      // Ignore non-JSON or unrelated responses.
    }
  };

  page.on("response", onResponse);

  try {
    if (!continueFromCurrent || !isFollowingUrl(page.url(), ownHandle, followingUrl)) {
      navigatedToFollowingPage = true;
      try {
        await page.goto(followingUrl, { waitUntil: "domcontentloaded" });
      } catch (error) {
        if (isGotoTimeoutError(error)) {
          throw new Error("X timed out while opening your Following page.");
        }

        throw error;
      }
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2500);
    }
    let recoveredState = await ensureFollowingPage(page, ownHandle, followingUrl);

    if (!isFollowingUrl(recoveredState.currentUrl, ownHandle, followingUrl)) {
      throw new Error(
        `X did not stay on your Following page and left the browser on ${recoveredState.currentUrl || "an unexpected page"} instead.`,
      );
    }

    if (await pageLooksLikeBlankXShell(page)) {
      throw new Error("X app shell got stuck on your Following page.");
    }

    recoveredState = await recoverFollowingPage(page, followingUrl);

    if (recoveredState.hasError) {
      throw new Error(
        "X returned 'Something went wrong. Try reloading.' on your Following page, so the tool could not read your follow list. Try opening your Following page manually, press Retry, then rerun.",
      );
    }

    const initialKnownCount = new Set([...networkUsers.keys(), ...domUsers.keys()]).size;

    if (navigatedToFollowingPage && knownFrontierHandles.length > 0 && initialKnownCount > 0) {
      const frontierAnchor = knownFrontierHandles[0];
      console.log(`Fast-forwarding to saved collection frontier near @${frontierAnchor}.`);

      for (let scrollCount = 0; scrollCount < Math.min(resolvedMaxScrolls, 180); scrollCount += 1) {
        const pageState = await ensureFollowingPage(page, ownHandle, followingUrl);

        if (!isFollowingUrl(pageState.currentUrl, ownHandle, followingUrl)) {
          throw new Error(
            `X left the Following page during collection and switched to ${pageState.currentUrl || "an unexpected page"}.`,
          );
        }

        if (await pageLooksLikeBlankXShell(page)) {
          throw new Error("X app shell got stuck on your Following page.");
        }

        const visibleRows = await readVisibleFollowingRows(page);
        const visibleHandleKeys = mergeVisibleFollowingRowsIntoDomUsers(visibleRows, domUsers, ownHandle);
        const combinedSize = new Set([...networkUsers.keys(), ...domUsers.keys()]).size;
        const frontierVisible = knownFrontierHandles.some((handle) => visibleHandleKeys.has(handle));

        await reportProgress({
          queued: combinedSize,
          scrollCount,
          idlePasses: 0,
          rowCount: visibleRows.length,
          done: combinedSize > initialKnownCount,
        });

        if (frontierVisible || combinedSize > initialKnownCount) {
          console.log(`Reached saved collection frontier near @${frontierAnchor}. Continuing collection from there.`);
          break;
        }

        if (scrollCount === Math.min(resolvedMaxScrolls, 180) - 1) {
          console.warn(
            `Could not quickly reach the saved collection frontier near @${frontierAnchor}. Continuing collection from the current page position.`,
          );
        }

        await advanceFollowingListQuick(page, scrollDelayMs);
      }
    }

    await reportProgress({
      queued: new Set([...networkUsers.keys(), ...domUsers.keys()]).size,
      scrollCount: 0,
      idlePasses: 0,
      rowCount: 0,
    });

    let idlePasses = 0;
    let previousTotal = 0;
    let previousRowCount = 0;
    let previousResponseCount = followingResponseCount;

    for (let scrollCount = 0; scrollCount < resolvedMaxScrolls; scrollCount += 1) {
      const pageState = await ensureFollowingPage(page, ownHandle, followingUrl);

      if (!isFollowingUrl(pageState.currentUrl, ownHandle, followingUrl)) {
        throw new Error(
          `X left the Following page during collection and switched to ${pageState.currentUrl || "an unexpected page"}.`,
        );
      }

      if (await pageLooksLikeBlankXShell(page)) {
        throw new Error("X app shell got stuck on your Following page.");
      }

      const visibleRows = await readVisibleFollowingRows(page);
      mergeVisibleFollowingRowsIntoDomUsers(visibleRows, domUsers, ownHandle);

      const combinedSize = new Set([...networkUsers.keys(), ...domUsers.keys()]).size;
      const currentRowCount = visibleRows.length;
      const progressed = (
        combinedSize > previousTotal
        || currentRowCount > previousRowCount
        || followingResponseCount > previousResponseCount
      );

      if (!progressed) {
        idlePasses += 1;
      } else {
        idlePasses = 0;
        previousTotal = combinedSize;
        previousRowCount = currentRowCount;
        previousResponseCount = followingResponseCount;
      }

      await reportProgress({
        queued: combinedSize,
        scrollCount: scrollCount + 1,
        idlePasses,
        rowCount: currentRowCount,
        done: combinedSize >= limit || idlePasses >= 8,
      });

      if (combinedSize >= limit) {
        break;
      }

      if (idlePasses >= 8) {
        break;
      }

      await advanceFollowingList(page, scrollDelayMs);
    }

    const handles = Array.from(new Set([...networkUsers.keys(), ...domUsers.keys()])).slice(0, limit);
    const seedDataByHandle = new Map(
      handles
        .map((handle) => [
          handle,
          mergeUserSummary(domUsers.get(handle), networkUsers.get(handle) ?? {
            handle,
            bioKnown: false,
            bio: "",
            followsYouKnown: false,
            followsYou: false,
            latestPostKnown: false,
            latestPostAt: null,
          }),
        ])
        .filter(([, summary]) => summary),
    );
    const diagnostics = await collectFollowingDiagnostics(page, ownHandle, followingUrl, {
      networkHandleCount: networkUsers.size,
      domHandleCount: domUsers.size,
      networkSummaryCount: Array.from(networkUsers.values()).filter((summary) =>
        summary.bioKnown || summary.latestPostKnown,
      ).length,
      domSummaryCount: Array.from(domUsers.values()).filter((summary) => summary.bioKnown).length,
      followingResponseCount,
    });

    return {
      handles,
      seedDataByHandle,
      diagnostics,
    };
  } finally {
    page.off("response", onResponse);
  }
}

async function collectFollowingDiagnostics(page, ownHandle, followingUrl, counts) {
  return page.evaluate(
    ({ ownHandle: ownHandleArg, followingUrl: followingUrlArg, counts: countsArg }) => ({
      ownHandle: ownHandleArg,
      requestedFollowingUrl: followingUrlArg,
      finalUrl: window.location.href,
      title: document.title,
      userCellCount: document.querySelectorAll('div[data-testid="UserCell"]').length,
      cellInnerCount: document.querySelectorAll('div[data-testid="cellInnerDiv"]').length,
      linkCount: document.querySelectorAll('main a[href^="/"]').length,
      followButtonCount: Array.from(document.querySelectorAll("button")).filter((button) =>
        /^(follow|following|requested)$/i.test((button.textContent ?? "").trim()),
      ).length,
      mainTextSnippet: (document.querySelector("main")?.innerText ?? "").slice(0, 1200),
      sampleLinks: Array.from(document.querySelectorAll('main a[href^="/"]'))
        .slice(0, 30)
        .map((anchor) => anchor.getAttribute("href")),
      ...countsArg,
    }),
    { ownHandle, followingUrl, counts },
  );
}

async function collectFollowingHandlesWithRecovery(
  session,
  options,
  ownHandle,
  existingSeedDataByHandle = new Map(),
  continueFromCurrent = false,
  onProgress = null,
  knownFollowingHandles = [],
) {
  let activeSession = session;
  let recovered = false;

  for (let attempt = 0; attempt <= COLLECTION_RECOVERY_ATTEMPTS; attempt += 1) {
    try {
      const collection = await collectFollowingHandles(
        activeSession.page,
        ownHandle,
        options.limit,
        options.maxScrolls,
        options.scrollDelayMs,
        existingSeedDataByHandle,
        continueFromCurrent,
        onProgress ? (progress) => onProgress(activeSession, progress) : null,
        knownFollowingHandles,
      );

      return { session: activeSession, collection, recovered };
    } catch (error) {
      if (!isRecoverableSessionError(error) || attempt === COLLECTION_RECOVERY_ATTEMPTS) {
        throw error;
      }

      activeSession = await recoverBrowserSessionWithRetry(options, activeSession, {
        reason: "Following-page recovery was needed",
      });
      recovered = true;
    }
  }
}

async function inspectAccount(page, handle, options, seedData = null) {
  const profileUrl = `https://x.com/${handle}`;
  const seededBio = seedData?.bio ?? "";
  const seededFollowsYou = seedData?.followsYou === true;
  const seededLatestPostAt = seedData?.latestPostAt ?? null;
  const allowlisted = isAllowlistedHandle(handle, options);
  const seededEvaluation = evaluateAccount({
    bio: seededBio,
    followsYou: seededFollowsYou,
    latestPostAt: seededLatestPostAt,
    hasNoPublicPosts: false,
    keepMutuals: options.keepMutuals,
    allowlisted,
    inactiveMonths: options.inactiveMonths,
    keywords: options.keywords,
  });

  if (allowlisted) {
    return buildAccountResult({
      handle,
      profileUrl,
      action: "kept",
      bio: seededBio,
      evaluation: seededEvaluation,
      note: "Account is on the allowlist, so it was kept.",
    });
  }

  if (seededFollowsYou) {
    return buildAccountResult({
      handle,
      profileUrl,
      action: "kept",
      bio: seededBio,
      evaluation: seededEvaluation,
      note: "Account follows you, so it was kept.",
    });
  }

  if (seededEvaluation.shouldUnfollow && !options.deepScan) {
    if (!options.apply) {
      return buildAccountResult({
        handle,
        profileUrl,
        action: "would-unfollow",
        bio: seededBio,
        evaluation: seededEvaluation,
        note: "Matched from following-list data.",
      });
    }
  } else if (!options.deepScan && shouldResolveFromSeedData(seedData, seededEvaluation, options.apply)) {
    return buildAccountResult({
      handle,
      profileUrl,
      action: seededEvaluation.shouldUnfollow ? "would-unfollow" : "kept",
      bio: seededBio,
      evaluation: seededEvaluation,
      note: seededEvaluation.shouldUnfollow ? "Matched from following-list data." : null,
    });
  } else if (!options.deepScan) {
    return buildAccountResult({
      handle,
      profileUrl,
      action: "unresolved",
      bio: seededBio,
      evaluation: seededEvaluation,
      note: "Fast scan skipped the inactivity profile lookup for this account. Re-run with --deep-scan to check inactivity too.",
    });
  }

  let profileApiSummary = null;
  const onResponse = async (response) => {
    const url = response.url();

    if (!url.includes("/i/api/graphql/") || !response.ok()) {
      return;
    }

    try {
      const payload = await response.json();
      const matchingSummary = extractUserSummariesFromApiPayload(payload)
        .find((summary) => summary.handle.toLowerCase() === handle.toLowerCase());

      if (matchingSummary) {
        profileApiSummary = mergeUserSummary(profileApiSummary, matchingSummary);
      }
    } catch {
      // Ignore unrelated or non-JSON responses.
    }
  };

  page.on("response", onResponse);

  try {
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(options.profileDelayMs);

    const profileReadyState = await waitForProfileReady(
      page,
      handle,
      profileUrl,
      options.profileDelayMs,
    );

    if (!profileReadyState.ready) {
      if (profileReadyState.recoverableShellStuck) {
        throw new Error(`X app shell got stuck while opening @${handle}.`);
      }

      if (profileReadyState.recoverableSurfaceError) {
        throw new Error(`X kept returning 'Something went wrong' while opening @${handle}.`);
      }

      if (profileReadyState.recoverableProfileRenderFailure) {
        throw new Error(`X did not render a usable profile for @${handle}.`);
      }

      const note = profileReadyState.unavailableReason
        ?? "Profile never finished loading on X, so it was skipped.";

      return {
        handle,
        profileUrl,
        action: "skipped",
        shouldUnfollow: false,
        reasons: [],
        note,
        bio: seededBio,
        latestPostAt: seededLatestPostAt,
      };
    }

    const unavailableReason = await detectUnavailableProfile(page);
    if (unavailableReason) {
      return {
        handle,
        profileUrl,
        action: "skipped",
        shouldUnfollow: false,
        reasons: [],
        note: unavailableReason,
        bio: seededBio,
        latestPostAt: seededLatestPostAt,
      };
    }

    if (seededEvaluation.shouldUnfollow) {
      const bio = pickPrimaryBio(
        await readBio(page),
        seededBio || (profileApiSummary?.bioKnown ? profileApiSummary.bio : ""),
      );

      if (options.apply) {
        await unfollowProfile(page, handle);
        await page.waitForTimeout(options.actionDelayMs);

        return buildAccountResult({
          handle,
          profileUrl,
          action: "unfollowed",
          bio,
          evaluation: seededEvaluation,
          note: "Matched from following-list data.",
        });
      }

      return buildAccountResult({
        handle,
        profileUrl,
        action: "would-unfollow",
        bio,
        evaluation: seededEvaluation,
        note: "Matched from following-list data.",
      });
    }

    const fallbackBio = pickPrimaryBio(
      seededBio,
      profileApiSummary?.bioKnown ? profileApiSummary.bio : "",
    );
    const bio = pickPrimaryBio(await readBio(page), fallbackBio);
    const followsYou = seededFollowsYou || await readFollowsYou(page);
    const fallbackLatestPostAt = pickKnownLatestPostAt(
      seededLatestPostAt,
      profileApiSummary?.latestPostKnown ? profileApiSummary.latestPostAt : null,
    );
    const latestPostProbe = fallbackLatestPostAt ?? await readLatestVisiblePostDate(
      page,
      handle,
      profileUrl,
      options.profileDelayMs,
      options,
    );
    const hasNoPublicPosts = latestPostProbe === NO_PUBLIC_POSTS_MARKER;
    const latestPostAt = hasNoPublicPosts ? null : latestPostProbe;
    const evaluation = evaluateAccount({
      bio,
      followsYou,
      latestPostAt,
      hasNoPublicPosts: options.treatNoPublicPostsAsInactive && hasNoPublicPosts,
      keepMutuals: options.keepMutuals,
      allowlisted,
      inactiveMonths: options.inactiveMonths,
      keywords: options.keywords,
    });

    let action = "kept";

    if (evaluation.shouldUnfollow && options.apply) {
      await unfollowProfile(page, handle);
      action = "unfollowed";
      await page.waitForTimeout(options.actionDelayMs);
    } else if (evaluation.shouldUnfollow) {
      action = "would-unfollow";
    }

    return buildAccountResult({
      handle,
      profileUrl,
      action,
      bio,
      evaluation,
    });
  } finally {
    page.off("response", onResponse);
  }
}

async function inspectAccountWithRecovery(session, options, handle, seedData) {
  try {
    const result = await inspectAccount(getInspectionPage(session), handle, options, seedData);
    return { session, result, recovered: false };
  } catch (error) {
    if (!isRecoverableSessionError(error)) {
      throw error;
    }

    let recoverySession = session;

    try {
      let recoveredSession = await recoverBrowserSessionWithRetry(options, session, {
        reason: "Profile recovery was needed",
      });
      recoverySession = recoveredSession;
      if (options.deepScan) {
        recoveredSession = await ensureWorkerPage(recoveredSession);
      }
      const result = await inspectAccount(getInspectionPage(recoveredSession), handle, options, seedData);

      if (result.note) {
        result.note = `${result.note} Session was restarted once during this scan.`;
      } else {
        result.note = "Session was restarted once during this scan.";
      }

      return { session: recoveredSession, result, recovered: true };
    } catch (recoveryError) {
      if (!isRecoverableSessionError(recoveryError)) {
        throw recoveryError;
      }
      throw recoveryError;
    }
  }
}

async function detectUnavailableProfile(page) {
  const pageText = await page.locator("main").textContent().catch(() => "");
  const normalized = String(pageText ?? "").toLowerCase();

  if (normalized.includes("this account doesn’t exist") || normalized.includes("this account doesn't exist")) {
    return "Profile does not exist.";
  }

  if (normalized.includes("account suspended")) {
    return "Profile is suspended.";
  }

  return null;
}

async function waitForProfileReady(page, handle, profileUrl, profileDelayMs) {
  let lastState = null;

  for (let attempt = 0; attempt <= PROFILE_READY_RETRIES; attempt += 1) {
    const deadline = Date.now() + PROFILE_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      let state = await readProfilePageState(page, handle);

      if (state.looksShellStuck) {
        return {
          ready: false,
          recoverableShellStuck: true,
          unavailableReason: "X stopped rendering profile pages and fell back to a blank app shell.",
        };
      }

      if (state.hasError) {
        state = await recoverProfileSurface(page, handle, profileUrl, profileDelayMs);

        if (state.hasError) {
          return {
            ready: false,
            recoverableSurfaceError: true,
            unavailableReason: "X kept returning 'Something went wrong. Try reloading.' on this profile.",
          };
        }
      }

      lastState = state;

      if (state.unavailableReason) {
        return {
          ready: false,
          unavailableReason: state.unavailableReason,
          state,
        };
      }

      if (isUsableProfilePageState(state, handle, profileUrl)) {
        return { ready: true, state };
      }

      await page.waitForTimeout(500);
    }

    if (attempt < PROFILE_READY_RETRIES) {
      console.warn(`@${handle} never rendered a usable profile page. Retrying once.`);
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(profileDelayMs).catch(() => {});
    }
  }

  if (lastState?.looksShellStuck) {
    return {
      ready: false,
      recoverableShellStuck: true,
      unavailableReason: "X stopped rendering profile pages and fell back to a blank app shell.",
    };
  }

  if (lastState?.hasError) {
    return {
      ready: false,
      recoverableSurfaceError: true,
      unavailableReason: "X kept returning 'Something went wrong. Try reloading.' on this profile.",
    };
  }

  return {
    ready: false,
    recoverableProfileRenderFailure: true,
    unavailableReason: "Profile never finished loading on X.",
  };
}

function isUsableProfilePageState(state, handle, profileUrl) {
  if (!state) {
    return false;
  }

  const normalizedHandle = handle.toLowerCase();
  const normalizedUrl = profileUrl.toLowerCase();
  const currentUrl = state.currentUrl.toLowerCase();
  const title = state.title.toLowerCase();
  const urlLooksRight = currentUrl.startsWith(normalizedUrl);
  const titleLooksRight = title.includes(`@${normalizedHandle}`);

  if (
    state.hasUserName
    || state.hasUserDescription
    || state.articleCount > 0
    || state.timeCount > 0
    || state.hasRelationshipButton
    || state.hasProfileTabs
  ) {
    return true;
  }

  if ((urlLooksRight || titleLooksRight) && state.mainTextLength >= 80) {
    return true;
  }

  return false;
}

async function readProfilePageState(page, handle) {
  return page.evaluate(({ handle: expectedHandle }) => {
    const main = document.querySelector("main");
    const mainText = (main?.innerText ?? "").trim();
    const bodyText = (document.body?.innerText ?? "").trim();
    const normalized = mainText.toLowerCase();
    const title = document.title.trim().toLowerCase();
    const buttons = Array.from(document.querySelectorAll("button")).map((button) =>
      (button.textContent ?? "").trim().toLowerCase(),
    );
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((tab) =>
      (tab.textContent ?? "").trim().toLowerCase(),
    );

    let unavailableReason = null;

    if (normalized.includes("this account doesn’t exist") || normalized.includes("this account doesn't exist")) {
      unavailableReason = "Profile does not exist.";
    } else if (normalized.includes("account suspended")) {
      unavailableReason = "Profile is suspended.";
    }

    return {
      currentUrl: window.location.href,
      title: document.title,
      mainTextLength: mainText.length,
      bodyTextLength: bodyText.length,
      hasError: normalized.includes("something went wrong. try reloading")
        || normalized.includes("something went wrong try reloading"),
      hasUserName: Boolean(document.querySelector('[data-testid="UserName"]')),
      hasUserDescription: Boolean(document.querySelector('[data-testid="UserDescription"]')),
      articleCount: document.querySelectorAll("main article").length,
      timeCount: document.querySelectorAll("main article time[datetime]").length,
      hasRelationshipButton: buttons.some((text) =>
        /^(follow|following|requested|unfollow)$/.test(text),
      ),
      hasProfileTabs: tabs.some((text) =>
        /^(posts|replies|media|likes|highlights|articles)$/i.test(text),
      ),
      retryButtonVisible: buttons.includes("retry"),
      looksShellStuck: mainText.length < 20
        && bodyText.length < 80
        && !document.querySelector('[data-testid="UserName"]')
        && !document.querySelector('[data-testid="UserDescription"]')
        && document.querySelectorAll("main article").length === 0
        && window.location.href.includes("x.com/")
        && (
          title === "x"
          || title === "x.com"
          || title === ""
        ),
      mentionsExpectedHandle: normalized.includes(`@${String(expectedHandle ?? "").toLowerCase()}`),
      unavailableReason,
    };
  }, { handle });
}

async function recoverProfileSurface(page, handle, profileUrl, profileDelayMs) {
  for (let attempt = 0; attempt < PROFILE_SURFACE_RECOVERY_ATTEMPTS; attempt += 1) {
    const state = await readProfilePageState(page, handle);

    if (!state.hasError) {
      return state;
    }

    console.warn(
      `X returned an error on @${handle}'s profile. Retry attempt ${attempt + 1}/${PROFILE_SURFACE_RECOVERY_ATTEMPTS}.`,
    );

    const retryButton = page.getByRole("button", { name: /^Retry$/i }).first();
    const clickedRetry = await retryButton.isVisible({ timeout: 1000 })
      .then(async (visible) => {
        if (!visible) {
          return false;
        }

        await retryButton.click();
        return true;
      })
      .catch(() => false);

    if (!clickedRetry) {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(PROFILE_SURFACE_RECOVERY_DELAY_MS + profileDelayMs);
  }

  return readProfilePageState(page, handle);
}

async function readBio(page) {
  return (
    (await page.locator('[data-testid="UserDescription"]').textContent().catch(() => ""))?.trim() ?? ""
  );
}

async function readFollowsYou(page) {
  const profileText = await page.evaluate(() => {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    const main = document.querySelector("main");
    return (primaryColumn?.innerText ?? main?.innerText ?? "");
  }).catch(() => "");

  return extractFollowsYouFromProfileText(profileText);
}

async function readLatestVisiblePostDate(page, handle, profileUrl, profileDelayMs, options) {
  for (let attempt = 0; attempt <= TIMELINE_READY_RETRIES; attempt += 1) {
    await ensurePostsTabSelected(page);
    await page.mouse.wheel(0, 1000).catch(() => {});
    await page.waitForTimeout(700);

    const profileState = await readProfilePageState(page, handle);
    if (profileState.hasError) {
      const recoveredState = await recoverProfileSurface(page, handle, profileUrl, profileDelayMs);

      if (recoveredState.hasError) {
        throw new Error(`X kept returning 'Something went wrong' while loading posts for @${handle}.`);
      }
    }

    const latestVisible = await waitForVisibleTimelineDate(page);

    if (latestVisible) {
      return latestVisible;
    }

    if (await profileShowsNoPosts(page)) {
      return NO_PUBLIC_POSTS_MARKER;
    }

    if (attempt < TIMELINE_READY_RETRIES) {
      console.warn(`@${handle} never exposed a visible post date. Reloading the profile once.`);
      await page.goto(profileUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(profileDelayMs).catch(() => {});
      const profileReadyState = await waitForProfileReady(
        page,
        handle,
        profileUrl,
        profileDelayMs,
      );

      if (!profileReadyState.ready) {
        return null;
      }
    }
  }

  if (options.treatHiddenProfilesAsInactive) {
    console.warn(`@${handle} still never exposed a visible post date after retry. Treating the profile as having no public posts.`);
    return NO_PUBLIC_POSTS_MARKER;
  }

  return null;
}

async function ensurePostsTabSelected(page) {
  const postsTab = page.getByRole("tab", { name: /^Posts$/i }).first();

  try {
    if (await postsTab.isVisible({ timeout: 1000 })) {
      const selected = await postsTab.getAttribute("aria-selected").catch(() => null);

      if (selected !== "true") {
        await postsTab.click().catch(() => {});
        await page.waitForTimeout(800);
      }
    }
  } catch {
    // Some profiles do not expose tabs in a stable way.
  }
}

async function waitForVisibleTimelineDate(page) {
  const deadline = Date.now() + TIMELINE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const datetimes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("main article time[datetime]"))
        .map((element) => element.getAttribute("datetime"))
        .filter(Boolean),
    ).catch(() => []);

    const timestamps = datetimes
      .map((value) => new Date(value))
      .filter((value) => Number.isFinite(value.getTime()))
      .map((value) => value.getTime());

    if (timestamps.length > 0) {
      return new Date(Math.max(...timestamps)).toISOString();
    }

    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(600);
  }

  return null;
}

async function profileShowsNoPosts(page) {
  const profileText = await page.evaluate(() => {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    const main = document.querySelector("main");
    const headerBits = Array.from(
      document.querySelectorAll(
        '[data-testid="primaryColumn"] h1, [data-testid="primaryColumn"] h2, [data-testid="primaryColumn"] [role="heading"], main h1, main h2, main [role="heading"]',
      ),
    )
      .slice(0, 20)
      .map((element) => element.textContent ?? "");

    return [
      primaryColumn?.innerText ?? "",
      main?.innerText ?? "",
      ...headerBits,
    ]
      .filter(Boolean)
      .join("\n");
  }).catch(() => "");

  return profileTextIndicatesNoPosts(profileText);
}

async function unfollowProfile(page, handle) {
  const relationshipState = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const labels = buttons
      .map((button) => (button.textContent ?? "").trim().toLowerCase())
      .filter(Boolean);

    return {
      hasFollowing: labels.includes("following"),
      hasFollow: labels.includes("follow") || labels.includes("follow back"),
      hasRequested: labels.includes("requested"),
    };
  }).catch(() => ({
    hasFollowing: false,
    hasFollow: false,
    hasRequested: false,
  }));

  const buttonCandidates = [
    page.locator('[data-testid$="-unfollow"]').first(),
    page.getByRole("button", { name: /^Following$/ }).first(),
    page.locator("button").filter({ hasText: /^Following$/ }).first(),
  ];

  let clicked = false;

  for (const candidate of buttonCandidates) {
    try {
      if (await candidate.isVisible({ timeout: 2000 })) {
        await candidate.click();
        clicked = true;
        break;
      }
    } catch {
      // Try the next selector if this one is not present in the current X layout.
    }
  }

  if (!clicked) {
    if (relationshipState.hasFollow || relationshipState.hasRequested) {
      throw new Error(`You no longer appear to be following @${handle}.`);
    }

    throw new Error(`Could not find the unfollow button for @${handle}.`);
  }

  const confirmCandidates = [
    page.locator('[data-testid="confirmationSheetConfirm"]').first(),
    page.getByRole("button", { name: /^Unfollow$/ }).first(),
  ];

  for (const candidate of confirmCandidates) {
    try {
      if (await candidate.isVisible({ timeout: 3000 })) {
        await candidate.click();
        return;
      }
    } catch {
      // Some X layouts unfollow immediately, so a missing dialog is acceptable.
    }
  }
}

async function writeReport(reportPath, payload) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(payload, null, 2), "utf8");
}

function serializeSeedData(seedDataByHandle) {
  return Object.fromEntries(seedDataByHandle?.entries?.() ?? []);
}

function deserializeSeedData(seedDataByHandle) {
  return new Map(Object.entries(seedDataByHandle ?? {}));
}

function buildRunStateSnapshot({
  options,
  effectiveLimit = options.limit,
  ownHandle,
  collectionComplete = false,
  followingHandles,
  seedDataByHandle,
  followingDiagnostics,
  results,
  summary = null,
  completed = false,
}) {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    completed,
    collectionComplete,
    ownHandle,
    config: {
      apply: options.apply,
      deepScan: options.deepScan,
      inactiveMonths: options.inactiveMonths,
      keywords: options.keywords,
      keepMutuals: options.keepMutuals,
      treatNoPublicPostsAsInactive: options.treatNoPublicPostsAsInactive,
      treatHiddenProfilesAsInactive: options.treatHiddenProfilesAsInactive,
      allowlistHandles: options.allowlistHandles,
      limit: effectiveLimit,
      requestedLimit: options.limit,
    },
    followingDiagnostics,
    followingHandles,
    seedDataByHandle: serializeSeedData(seedDataByHandle),
    results,
    summary,
  };
}

async function writeRunState(stateFilePath, snapshot) {
  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, JSON.stringify(snapshot, null, 2), "utf8");
}

async function readRunState(stateFilePath) {
  const raw = await readFile(stateFilePath, "utf8");
  const parsed = JSON.parse(raw);

  return {
    ...parsed,
    collectionComplete: Boolean(parsed.collectionComplete),
    followingHandles: Array.isArray(parsed.followingHandles) ? parsed.followingHandles : [],
    seedDataByHandle: deserializeSeedData(parsed.seedDataByHandle),
    results: Array.isArray(parsed.results) ? parsed.results : [],
  };
}

function summarizeResults(results) {
  return results.reduce(
    (summary, result) => {
      summary.scanned += 1;

      if (result.shouldUnfollow) {
        summary.matched += 1;
      }

      if (result.action === "unfollowed") {
        summary.unfollowed += 1;
      }

      if (result.action === "skipped") {
        summary.skipped += 1;
      }

      if (result.action === "would-unfollow") {
        summary.wouldUnfollow += 1;
      }

      if (result.action === "unresolved") {
        summary.unresolved += 1;
      }

      return summary;
    },
    {
      scanned: 0,
      matched: 0,
      unfollowed: 0,
      skipped: 0,
      unresolved: 0,
      wouldUnfollow: 0,
    },
  );
}

async function main() {
  const options = await applyConfigDefaults(readCliOptions());

  if (options.help) {
    printHelp();
    return;
  }

  let session = await createBrowserSession(options);
  let recoveryCount = 0;
  let runCompleted = false;
  let results;
  let lastCollectionProgressMessage = "";
  let lastCollectionProgressAt = 0;
  let lastCollectionQueued = -1;
  let lastCollectionScroll = -1;
  let lastCollectionIdlePasses = -1;

  try {
    console.log(`Using ${session.browserLabel} with session dir ${options.userDataDir}`);
    await ensureLoggedIn(session.page, options);
    let runState = null;

    if (options.resume && await pathExists(options.stateFile)) {
      runState = await readRunState(options.stateFile);

      if (!runConfigsMatch(runState.config, getCurrentRunConfig(options))) {
        throw new Error(
          `The saved state file ${options.stateFile} was created with different policy or mode settings. Start with a fresh state file or rerun without --resume so old cached decisions are not mixed with the new config.`,
        );
      }

      console.log(
        `Resuming from ${options.stateFile} at ${runState.results.length}/${runState.followingHandles.length} checked accounts.`,
      );
    }

    const ownHandle = runState?.ownHandle ?? await getOwnHandle(session.page, options);
    session = await initializeDashboardSession(session, options);
    console.log(`Logged in as @${ownHandle}`);
    await updateProgressDashboard(session, {
      ownHandle,
      phase: "Collecting followed accounts",
      apply: options.apply,
      deepScan: options.deepScan,
      recoveries: recoveryCount,
    });

    let followingHandles;
    let seedDataByHandle;
    let followingDiagnostics;
    let collectionComplete;

    const reportCollectionProgress = async (activeSession, progress) => {
      const now = Date.now();
      const shouldRender = (
        progress.done
        || now - lastCollectionProgressAt >= COLLECTION_PROGRESS_THROTTLE_MS
        || progress.queued - lastCollectionQueued >= 25
        || progress.scrollCount - lastCollectionScroll >= 10
        || progress.idlePasses !== lastCollectionIdlePasses
      );

      if (!shouldRender) {
        return;
      }

      lastCollectionProgressAt = now;
      lastCollectionQueued = progress.queued;
      lastCollectionScroll = progress.scrollCount;
      lastCollectionIdlePasses = progress.idlePasses;

      const currentResults = Array.isArray(results) ? results : [];
      const matched = currentResults.filter((result) => result.shouldUnfollow).length;
      const unresolved = currentResults.filter((result) => result.action === "unresolved").length;
      const idleSuffix = progress.idlePasses > 0 ? `, idle ${progress.idlePasses}/8` : "";
      const phase = progress.done
        ? `Collection batch ready (${progress.queued}/${progress.limit} queued)`
        : `Collecting follow queue (${progress.queued}/${progress.limit} queued, scroll ${progress.scrollCount}/${progress.maxScrolls}${idleSuffix})`;

      if (phase !== lastCollectionProgressMessage) {
        console.log(phase);
        lastCollectionProgressMessage = phase;
      }

      await updateProgressDashboard(activeSession, {
        ownHandle,
        phase,
        scanned: currentResults.length,
        total: progress.queued,
        matched,
        unresolved,
        recoveries: recoveryCount,
        apply: options.apply,
        deepScan: options.deepScan,
      });
    };

    if (runState) {
      followingHandles = runState.followingHandles;
      seedDataByHandle = runState.seedDataByHandle ?? new Map();
      followingDiagnostics = runState.followingDiagnostics ?? null;
      results = runState.results ?? [];
      collectionComplete = Boolean(runState.collectionComplete);
    } else if (!options.deepScan) {
      const followingStep = await collectFollowingHandlesWithRecovery(
        session,
        options,
        ownHandle,
        new Map(),
        false,
        reportCollectionProgress,
        [],
      );
      session = followingStep.session;
      if (followingStep.recovered) {
        recoveryCount += 1;
      }
      const followingCollection = followingStep.collection;
      followingHandles = followingCollection.handles;
      seedDataByHandle = followingCollection.seedDataByHandle ?? new Map();
      followingDiagnostics = followingCollection.diagnostics;
      results = [];
      collectionComplete = true;

      await writeRunState(options.stateFile, buildRunStateSnapshot({
        options,
        ownHandle,
        collectionComplete,
        followingHandles,
        seedDataByHandle,
        followingDiagnostics,
        results,
      }));
    } else {
      session = await ensureWorkerPage(session);
      followingHandles = [];
      seedDataByHandle = new Map();
      followingDiagnostics = null;
      results = [];
      collectionComplete = false;

      await writeRunState(options.stateFile, buildRunStateSnapshot({
        options,
        ownHandle,
        collectionComplete,
        followingHandles,
        seedDataByHandle,
        followingDiagnostics,
        results,
      }));
    }

    results = dedupeResults(results);
    const runLimit = Math.max(options.limit, followingHandles.length, results.length);
    const resultCache = buildResultCache(results, options);
    const deferredHandleKeys = new Set();

    if (runState && runLimit > options.limit) {
      console.warn(
        `This checkpoint already contains ${followingHandles.length} collected handles and ${results.length} saved results, so the effective limit for this resumed run is ${runLimit}. Pass --limit greater than ${runLimit} if you want the scan to continue to newer accounts.`,
      );
    }

    console.log(`Collected ${followingHandles.length} followed accounts for evaluation.`);
    await updateProgressDashboard(session, {
      ownHandle,
      phase: options.deepScan ? "Collecting and resolving accounts" : "Resolving accounts",
      scanned: results.length,
      total: followingHandles.length,
      matched: results.filter((result) => result.shouldUnfollow).length,
      unresolved: results.filter((result) => result.action === "unresolved").length,
      recoveries: recoveryCount,
      apply: options.apply,
      deepScan: options.deepScan,
    });
    if (followingHandles.length === 0) {
      console.warn("No followed accounts were detected. Debug details were added to the JSON report.");
    }

    while (countProcessedHandles(resultCache, deferredHandleKeys) < runLimit) {
      const nextUncheckedHandle = findNextUncheckedHandle(
        followingHandles,
        resultCache,
        deferredHandleKeys,
      );

      if (!nextUncheckedHandle) {
        if (collectionComplete) {
          break;
        }

        await bringPageToFront(session.page);
        const previousCount = followingHandles.length;
        const targetLimit = Math.min(
          runLimit,
          Math.max(previousCount + options.collectBatchSize, results.length + 1),
        );
        const collectionStep = await collectFollowingHandlesWithRecovery(
          session,
          { ...options, limit: targetLimit },
          ownHandle,
          seedDataByHandle,
          previousCount > 0,
          reportCollectionProgress,
          followingHandles,
        );
        session = collectionStep.session;
        if (collectionStep.recovered) {
          recoveryCount += 1;
        }
        if (options.deepScan) {
          session = await ensureWorkerPage(session);
        }

        const collection = collectionStep.collection;
        followingHandles = collection.handles;
        seedDataByHandle = collection.seedDataByHandle ?? seedDataByHandle;
        followingDiagnostics = collection.diagnostics;
        collectionComplete = followingHandles.length >= runLimit
          || followingHandles.length === previousCount;

        console.log(
          `Collected ${followingHandles.length}/${runLimit} followed accounts${collectionComplete ? " and reached the current collection limit." : ". Starting checks on this batch now."}`,
        );

        await writeRunState(options.stateFile, buildRunStateSnapshot({
          options,
          effectiveLimit: runLimit,
          ownHandle,
          collectionComplete,
          followingHandles,
          seedDataByHandle,
          followingDiagnostics,
          results,
        }));

        if (!findNextUncheckedHandle(followingHandles, resultCache, deferredHandleKeys) && collectionComplete) {
          break;
        }

        continue;
      }

      const handle = nextUncheckedHandle;
      const processedCount = countProcessedHandles(resultCache, deferredHandleKeys);

      if ((options.apply || options.deepScan) && processedCount > 0) {
        await waitBetweenDeepProfileChecks(getInspectionPage(session), options.accountDelayMs);
      }

      if ((options.apply || options.deepScan) && !isSessionUsable(session)) {
        session = await recoverBrowserSessionWithRetry(options, session, {
          reason: "The previous profile recovery left the browser session unusable",
        });
        recoveryCount += 1;
        if (options.deepScan) {
          session = await ensureWorkerPage(session);
        }
      }

      await bringPageToFront(session.uiPage ?? getInspectionPage(session));
      console.log(`[${processedCount + 1}/${Math.max(followingHandles.length, processedCount + 1)}] Opening @${handle}`);
      await updateProgressDashboard(session, {
        ownHandle,
        phase: "Opening profile",
        currentHandle: handle,
        scanned: processedCount,
        total: followingHandles.length,
        matched: results.filter((result) => result.shouldUnfollow).length,
        unresolved: results.filter((result) => result.action === "unresolved").length,
        recoveries: recoveryCount,
        apply: options.apply,
        deepScan: options.deepScan,
      });

      try {
        const inspected = await inspectAccountWithRecovery(
          session,
          options,
          handle,
          seedDataByHandle.get(handle),
        );
        session = inspected.session;
        if (inspected.recovered) {
          recoveryCount += 1;
        }
        if (options.deepScan) {
          session = await ensureWorkerPage(session);
        }
        const handleKey = normalizeHandleKey(inspected.result.handle);

        upsertResult(results, inspected.result);

        if (isResultCacheable(inspected.result, options)) {
          resultCache.set(handleKey, inspected.result);
          deferredHandleKeys.delete(handleKey);
        } else {
          resultCache.delete(handleKey);
          deferredHandleKeys.add(handleKey);
        }
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        const normalizedNote = note.toLowerCase();
        const result = {
          handle,
          profileUrl: `https://x.com/${handle}`,
          action: normalizedNote.includes("no longer appear to be following")
            ? "skipped"
            : "error",
          shouldUnfollow: false,
          reasons: [],
          note,
          bio: "",
          latestPostAt: null,
        };
        const handleKey = normalizeHandleKey(handle);
        upsertResult(results, result);
        if (isResultCacheable(result, options)) {
          resultCache.set(handleKey, result);
          deferredHandleKeys.delete(handleKey);
        } else {
          resultCache.delete(handleKey);
          deferredHandleKeys.add(handleKey);
        }
      }

      await writeRunState(options.stateFile, buildRunStateSnapshot({
        options,
        effectiveLimit: runLimit,
        ownHandle,
        collectionComplete,
        followingHandles,
        seedDataByHandle,
        followingDiagnostics,
        results,
      }));
    }

    const summary = summarizeResults(results);
    const reportPayload = {
      generatedAt: new Date().toISOString(),
      dryRun: !options.apply,
      config: {
        inactiveMonths: options.inactiveMonths,
        keywords: options.keywords,
        keepMutuals: options.keepMutuals,
        treatNoPublicPostsAsInactive: options.treatNoPublicPostsAsInactive,
        treatHiddenProfilesAsInactive: options.treatHiddenProfilesAsInactive,
        allowlistHandles: options.allowlistHandles,
        limit: runLimit,
        requestedLimit: options.limit,
        deepScan: options.deepScan,
      },
      runDiagnostics: {
        sessionRecoveries: recoveryCount,
      },
      followingDiagnostics,
      summary,
      results,
    };

    await writeReport(options.report, reportPayload);
    await writeRunState(options.stateFile, buildRunStateSnapshot({
      options,
      effectiveLimit: runLimit,
      ownHandle,
      collectionComplete,
      followingHandles,
      seedDataByHandle,
      followingDiagnostics,
      results,
      summary,
      completed: true,
    }));

    console.table(
      results.map((result) => ({
        handle: result.handle,
        action: result.action,
        latestPostAt: result.latestPostAt ?? "unknown",
        reasons: result.reasons.join(" | ") || result.note || "",
      })),
    );

    console.log(`Report saved to ${options.report}`);
    console.log(JSON.stringify(summary, null, 2));
    await updateProgressDashboard(session, {
      ownHandle,
      phase: "Run complete",
      scanned: summary.scanned,
      total: followingHandles.length,
      matched: summary.matched,
      unresolved: summary.unresolved,
      recoveries: recoveryCount,
      apply: options.apply,
      deepScan: options.deepScan,
    });
    runCompleted = true;
  } finally {
    if (options.headed && runCompleted) {
      console.log("Leaving the headed browser open so you can inspect the final page state.");
    } else {
      await closeBrowserSession(session);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
