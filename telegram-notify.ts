import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

// Helper to get real script directory (handles symlinks)
function getScriptDir(): string {
  return dirname(realpathSync(fileURLToPath(import.meta.url)));
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function loadConfig(): TelegramConfig {
  const home = process.env.HOME ?? "~";
  const scriptDir = getScriptDir();
  const candidates = [
    resolve(scriptDir, "telegram-config.json"),
    resolve(home, ".pi", "agent", "extensions", "telegram-config.json"),
    resolve(process.cwd(), "telegram-config.json"),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const config = JSON.parse(raw) as TelegramConfig;
      if (config.botToken && config.chatId) {
        return config;
      }
    } catch {
      // try next
    }
  }

  throw new Error(
    "telegram-config.json not found. Place it next to telegram-notify.ts or in ~/.pi/agent/extensions/"
  );
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: string
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body: Record<string, string> = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };

  return {
    ok: data.ok,
    result: data.result,
    error: data.ok ? undefined : data.description,
  };
}

// --- Bridge Process Management ---

const PID_DIR = resolve(process.env.HOME ?? "~", ".pi");
const PID_FILE = resolve(PID_DIR, "telegram-bridge.pid");
const LOG_FILE = resolve(PID_DIR, "telegram-bridge.log");

function getBridgePid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process not running, clean up stale PID file
      return null;
    }
  } catch {
    return null;
  }
}

function isBridgeRunning(): boolean {
  return getBridgePid() !== null;
}

async function checkBotStatus(botToken: string): Promise<string> {
  const lines: string[] = [];

  // Bot info
  try {
    const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = (await meResp.json()) as {
      ok: boolean;
      result?: { username: string; first_name: string; id: number };
    };
    if (meData.ok && meData.result) {
      lines.push(`Bot: @${meData.result.username} (${meData.result.first_name})`);
      lines.push(`ID: ${meData.result.id}`);
    } else {
      lines.push("Error: Failed to get bot info");
    }
  } catch (e) {
    lines.push(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Webhook info
  try {
    const whResp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const whData = (await whResp.json()) as {
      ok: boolean;
      result?: { url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string };
    };
    if (whData.ok && whData.result) {
      const { url, pending_update_count, last_error_date, last_error_message } = whData.result;
      lines.push(`Webhook: ${url || "(none - using polling)"}`);
      lines.push(`Pending updates: ${pending_update_count}`);
      if (last_error_date && last_error_message) {
        const errDate = new Date(last_error_date * 1000).toLocaleString();
        lines.push(`Last error: ${errDate} - ${last_error_message}`);
      }
    }
  } catch (e) {
    lines.push(`Webhook check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Bridge status
  const pid = getBridgePid();
  lines.push(`Bridge: ${pid ? `running (PID ${pid})` : "stopped"}`);

  return lines.join("\n");
}

async function sendTestMessage(botToken: string, chatId: string): Promise<string> {
  const result = await sendTelegramMessage(botToken, chatId, "pi test message");
  if (result.ok) {
    return "Test message sent successfully";
  }
  return `Failed: ${result.error ?? "unknown error"}`;
}

function startBridge(): string {
  if (isBridgeRunning()) {
    return "Bridge is already running";
  }

  const scriptDir = getScriptDir();
  const bridgePath = resolve(scriptDir, "telegram-bridge.ts");
  if (!existsSync(bridgePath)) {
    return `Error: telegram-bridge.ts not found at ${bridgePath}`;
  }

  const logFd = openSync(LOG_FILE, "w");
  const child = spawn("npx", ["tsx", bridgePath], {
    cwd: dirname(bridgePath),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  if (child.pid) {
    if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(child.pid));
    return `Bridge started (PID ${child.pid})\nLogs: ${LOG_FILE}`;
  }
  return "Error: Failed to start bridge process";
}

function stopBridge(): string {
  const pid = getBridgePid();
  if (!pid) {
    return "Bridge is not running";
  }

  try {
    process.kill(pid, "SIGTERM");
    // Wait briefly and check if it died
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        // still alive, wait a bit
        execSync("sleep 0.2");
      } catch {
        break; // dead
      }
    }
    // Force kill if still alive
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
    return "Bridge stopped";
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }
}

function viewBridgeLogs(): string {
  if (!existsSync(LOG_FILE)) {
    return "No log file found. Start the bridge first.";
  }
  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    if (!content.trim()) {
      return "Log file is empty.";
    }
    // Show last 30 lines
    const lines = content.split("\n");
    const tail = lines.slice(-30).join("\n");
    return `--- Last ${Math.min(30, lines.length)} lines ---\n${tail}`;
  } catch (e) {
    return `Error reading logs: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function checkConfig(config: TelegramConfig): string {
  const masked = config.botToken.slice(0, 10) + "..." + config.botToken.slice(-5);
  return [
    `Bot Token: ${masked}`,
    `Chat ID: ${config.chatId}`,
  ].join("\n");
}

async function setupWizard(ctx: any): Promise<TelegramConfig | null> {
  ctx.ui.notify("=== Telegram Bridge Setup ===", "info");
  ctx.ui.notify("Let's configure your Telegram bot connection.", "info");

  // Step 1: Get bot token
  ctx.ui.notify("", "info");
  ctx.ui.notify("Step 1: Create a Telegram Bot", "info");
  ctx.ui.notify("1. Open Telegram and search for @BotFather", "info");
  ctx.ui.notify("2. Send /newbot and follow the instructions", "info");
  ctx.ui.notify("3. Copy the bot token you receive", "info");
  ctx.ui.notify("", "info");

  const botToken = await ctx.ui.input("Bot Token", "Enter your bot token from @BotFather");
  if (!botToken) {
    ctx.ui.notify("Setup cancelled.", "error");
    return null;
  }

  // Step 2: Get chat ID
  ctx.ui.notify("", "info");
  ctx.ui.notify("Step 2: Get your Chat ID", "info");
  ctx.ui.notify("1. Send any message to your new bot", "info");
  ctx.ui.notify("2. Visit https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates", "info");
  ctx.ui.notify("3. Find your chat.id in the response", "info");
  ctx.ui.notify("", "info");

  const chatId = await ctx.ui.input("Chat ID", "Enter your chat ID");
  if (!chatId) {
    ctx.ui.notify("Setup cancelled.", "error");
    return null;
  }

  // Step 3: Test connection
  ctx.ui.notify("", "info");
  ctx.ui.notify("Step 3: Testing connection...", "info");

  const testResult = await sendTelegramMessage(botToken, chatId, "Telegram Bridge setup test successful!");
  if (!testResult.ok) {
    ctx.ui.notify(`Failed to send test message: ${testResult.error}`, "error");
    ctx.ui.notify("Please check your bot token and chat ID.", "error");
    return null;
  }

  ctx.ui.notify("Test message sent successfully!", "info");

  // Step 4: Ask user to reply
  ctx.ui.notify("", "info");
  ctx.ui.notify("Step 4: Verify connection", "info");
  ctx.ui.notify("Please reply to the test message in Telegram.", "info");
  ctx.ui.notify("Press Enter here after you've replied...", "info");

  await ctx.ui.input("Continue", "Press Enter after replying");

  // Step 5: Save configuration
  const config: TelegramConfig = { botToken, chatId };
  const scriptDir = getScriptDir();
  const configPath = resolve(scriptDir, "telegram-config.json");

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    ctx.ui.notify(`Configuration saved to: ${configPath}`, "info");
  } catch (e) {
    ctx.ui.notify(`Failed to save config: ${e instanceof Error ? e.message : String(e)}`, "error");
    return null;
  }

  ctx.ui.notify("", "info");
  ctx.ui.notify("=== Setup Complete ===", "info");
  ctx.ui.notify("Your Telegram bridge is now configured!", "info");

  return config;
}

function uninstallAll(): string {
  const messages: string[] = [];

  // 1. Stop bridge
  const stopResult = stopBridge();
  messages.push(stopResult);

  // 2. Uninstall service
  const uninstallResult = uninstallService();
  messages.push(uninstallResult);

  // 3. Remove extension symlink
  const home = process.env.HOME ?? "~";
  const extensionPath = resolve(home, ".pi", "agent", "extensions", "telegram-notify.ts");

  try {
    if (existsSync(extensionPath)) {
      unlinkSync(extensionPath);
      messages.push(`Removed extension symlink: ${extensionPath}`);
    }
  } catch (e) {
    messages.push(`Warning: Could not remove extension symlink: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Remove PID file
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
      messages.push(`Removed PID file: ${PID_FILE}`);
    }
  } catch {}

  // 5. Show cleanup instructions
  messages.push("");
  messages.push("=== Uninstall Complete ===");
  messages.push("");
  messages.push("The following files can be manually deleted if no longer needed:");
  messages.push(`  - Plugin directory: ${getScriptDir()}`);
  messages.push(`  - Config file: ${resolve(getScriptDir(), "telegram-config.json")}`);
  messages.push(`  - Log file: ${LOG_FILE}`);
  messages.push("");
  messages.push("To delete everything, run:");
  messages.push(`  rm -rf ${getScriptDir()}`);
  messages.push(`  rm -f ${LOG_FILE}`);

  return messages.join("\n");
}

// --- Launchd Service Management (macOS) ---

const LAUNCHD_LABEL = "com.pi.telegram-bridge";
const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;

function getLaunchdPlistPath(): string {
  return resolve(process.env.HOME ?? "~", "Library", "LaunchAgents", LAUNCHD_PLIST_NAME);
}

function isLaunchdServiceInstalled(): boolean {
  if (platform() !== "darwin") return false;
  return existsSync(getLaunchdPlistPath());
}

function installLaunchdService(): string {
  if (platform() !== "darwin") {
    return "Launchd is only available on macOS. Use systemd on Linux.";
  }

  const scriptDir = getScriptDir();
  const startScriptPath = resolve(scriptDir, "start-bridge.sh");
  const plistPath = getLaunchdPlistPath();
  const launchAgentsDir = dirname(plistPath);

  if (!existsSync(startScriptPath)) {
    return `Error: start-bridge.sh not found at ${startScriptPath}`;
  }

  // Ensure LaunchAgents directory exists
  if (!existsSync(launchAgentsDir)) {
    mkdirSync(launchAgentsDir, { recursive: true });
  }

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${startScriptPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${scriptDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${process.env.HOME ?? "~"}</string>
    </dict>
</dict>
</plist>`;

  try {
    writeFileSync(plistPath, plistContent, "utf-8");
    return `Launchd service installed: ${plistPath}`;
  } catch (e) {
    return `Error installing launchd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function uninstallLaunchdService(): string {
  if (platform() !== "darwin") {
    return "Launchd is only available on macOS.";
  }

  const plistPath = getLaunchdPlistPath();

  if (!existsSync(plistPath)) {
    return "Launchd service is not installed.";
  }

  try {
    // Unload the service first
    try {
      execSync(`launchctl unload "${plistPath}"`, { encoding: "utf-8" });
    } catch {
      // Service might not be loaded
    }

    unlinkSync(plistPath);
    return "Launchd service uninstalled.";
  } catch (e) {
    return `Error uninstalling launchd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function loadLaunchdService(): string {
  if (platform() !== "darwin") {
    return "Launchd is only available on macOS.";
  }

  const plistPath = getLaunchdPlistPath();

  if (!existsSync(plistPath)) {
    return "Launchd service is not installed. Run restart first.";
  }

  try {
    execSync(`launchctl load "${plistPath}"`, { encoding: "utf-8" });
    return "Launchd service loaded.";
  } catch (e) {
    return `Error loading launchd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function unloadLaunchdService(): string {
  if (platform() !== "darwin") {
    return "Launchd is only available on macOS.";
  }

  const plistPath = getLaunchdPlistPath();

  if (!existsSync(plistPath)) {
    return "Launchd service is not installed.";
  }

  try {
    execSync(`launchctl unload "${plistPath}"`, { encoding: "utf-8" });
    return "Launchd service unloaded.";
  } catch (e) {
    return `Error unloading launchd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function getLaunchdServiceStatus(): string {
  if (platform() !== "darwin") {
    return "Launchd is only available on macOS.";
  }

  const installed = isLaunchdServiceInstalled();
  const plistPath = getLaunchdPlistPath();

  if (!installed) {
    return "Launchd service: not installed";
  }

  // Check if service is loaded
  let loaded = false;
  try {
    const output = execSync(`launchctl list | grep ${LAUNCHD_LABEL}`, { encoding: "utf-8" });
    loaded = output.includes(LAUNCHD_LABEL);
  } catch {
    loaded = false;
  }

  return [
    `Launchd service: installed`,
    `Plist: ${plistPath}`,
    `Status: ${loaded ? "loaded (running on boot)" : "not loaded"}`,
  ].join("\n");
}

// --- Systemd Service Management (Linux) ---

const SYSTEMD_SERVICE_NAME = "pi-telegram-bridge";

function getSystemdServicePath(): string {
  return resolve(process.env.HOME ?? "~", ".config", "systemd", "user", `${SYSTEMD_SERVICE_NAME}.service`);
}

function isSystemdServiceInstalled(): boolean {
  if (platform() !== "linux") return false;
  return existsSync(getSystemdServicePath());
}

function installSystemdService(): string {
  if (platform() !== "linux") {
    return "Systemd is only available on Linux.";
  }

  const scriptDir = getScriptDir();
  const bridgePath = resolve(scriptDir, "telegram-bridge.ts");
  const servicePath = getSystemdServicePath();
  const serviceDir = dirname(servicePath);

  if (!existsSync(bridgePath)) {
    return `Error: telegram-bridge.ts not found at ${bridgePath}`;
  }

  // Ensure systemd user directory exists
  if (!existsSync(serviceDir)) {
    mkdirSync(serviceDir, { recursive: true });
  }

  // Find node/npx path
  let npxPath: string;
  try {
    npxPath = execSync("which npx", { encoding: "utf-8" }).trim();
  } catch {
    npxPath = "/usr/bin/npx";
  }

  // Get user home directory
  const home = process.env.HOME ?? "~";

  const serviceContent = `[Unit]
Description=Pi Telegram Bridge Service
After=network.target

[Service]
Type=simple
ExecStart=${npxPath} tsx ${bridgePath}
WorkingDirectory=${scriptDir}
Restart=always
RestartSec=10
Environment=HOME=${home}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${dirname(npxPath)}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target`;

  try {
    writeFileSync(servicePath, serviceContent, "utf-8");

    // Reload systemd and enable the service
    try {
      execSync("systemctl --user daemon-reload", { encoding: "utf-8" });
      execSync(`systemctl --user enable ${SYSTEMD_SERVICE_NAME}`, { encoding: "utf-8" });
    } catch (e) {
      return `Service file created but failed to enable: ${e instanceof Error ? e.message : String(e)}`;
    }

    return `Systemd service installed: ${servicePath}`;
  } catch (e) {
    return `Error installing systemd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function uninstallSystemdService(): string {
  if (platform() !== "linux") {
    return "Systemd is only available on Linux.";
  }

  const servicePath = getSystemdServicePath();

  if (!existsSync(servicePath)) {
    return "Systemd service is not installed.";
  }

  try {
    // Disable and stop the service
    try {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME}`, { encoding: "utf-8" });
      execSync(`systemctl --user disable ${SYSTEMD_SERVICE_NAME}`, { encoding: "utf-8" });
    } catch {
      // Service might not be running
    }

    unlinkSync(servicePath);

    // Reload systemd
    try {
      execSync("systemctl --user daemon-reload", { encoding: "utf-8" });
    } catch {}

    return "Systemd service uninstalled.";
  } catch (e) {
    return `Error uninstalling systemd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function loadSystemdService(): string {
  if (platform() !== "linux") {
    return "Systemd is only available on Linux.";
  }

  const servicePath = getSystemdServicePath();

  if (!existsSync(servicePath)) {
    return "Systemd service is not installed. Run restart first.";
  }

  try {
    execSync(`systemctl --user start ${SYSTEMD_SERVICE_NAME}`, { encoding: "utf-8" });
    return "Systemd service started.";
  } catch (e) {
    return `Error starting systemd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function unloadSystemdService(): string {
  if (platform() !== "linux") {
    return "Systemd is only available on Linux.";
  }

  const servicePath = getSystemdServicePath();

  if (!existsSync(servicePath)) {
    return "Systemd service is not installed.";
  }

  try {
    execSync(`systemctl --user stop ${SYSTEMD_SERVICE_NAME}`, { encoding: "utf-8" });
    return "Systemd service stopped.";
  } catch (e) {
    return `Error stopping systemd service: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function getSystemdServiceStatus(): string {
  if (platform() !== "linux") {
    return "Systemd is only available on Linux.";
  }

  const installed = isSystemdServiceInstalled();
  const servicePath = getSystemdServicePath();

  if (!installed) {
    return "Systemd service: not installed";
  }

  // Check if service is active
  let active = false;
  let enabled = false;
  try {
    const status = execSync(`systemctl --user is-active ${SYSTEMD_SERVICE_NAME}`, { encoding: "utf-8" }).trim();
    active = status === "active";
  } catch {
    active = false;
  }

  try {
    const status = execSync(`systemctl --user is-enabled ${SYSTEMD_SERVICE_NAME}`, { encoding: "utf-8" }).trim();
    enabled = status === "enabled";
  } catch {
    enabled = false;
  }

  return [
    `Systemd service: installed`,
    `Service file: ${servicePath}`,
    `Status: ${active ? "active (running)" : "inactive"}`,
    `Enabled: ${enabled ? "yes (starts on boot)" : "no"}`,
  ].join("\n");
}

// --- Platform-agnostic service management ---

function isServiceInstalled(): boolean {
  const os = platform();
  if (os === "darwin") return isLaunchdServiceInstalled();
  if (os === "linux") return isSystemdServiceInstalled();
  return false;
}

function installService(): string {
  const os = platform();
  if (os === "darwin") return installLaunchdService();
  if (os === "linux") return installSystemdService();
  return `Unsupported platform: ${os}`;
}

function uninstallService(): string {
  const os = platform();
  if (os === "darwin") return uninstallLaunchdService();
  if (os === "linux") return uninstallSystemdService();
  return `Unsupported platform: ${os}`;
}

function startService(): string {
  const os = platform();
  if (os === "darwin") return loadLaunchdService();
  if (os === "linux") return loadSystemdService();
  return `Unsupported platform: ${os}`;
}

function stopService(): string {
  const os = platform();
  if (os === "darwin") return unloadLaunchdService();
  if (os === "linux") return unloadSystemdService();
  return `Unsupported platform: ${os}`;
}

function getServiceStatus(): string {
  const os = platform();
  if (os === "darwin") return getLaunchdServiceStatus();
  if (os === "linux") return getSystemdServiceStatus();
  return `Unsupported platform: ${os}`;
}

async function restartBridge(): Promise<string> {
  const messages: string[] = [];

  // 1. Stop existing bridge (PID-based)
  const stopResult = stopBridge();
  messages.push(stopResult);

  // 2. Uninstall existing service to ensure clean state
  if (isServiceInstalled()) {
    const uninstallResult = uninstallService();
    messages.push(uninstallResult);
  }

  // 3. Install fresh service
  const installResult = installService();
  messages.push(installResult);

  // 4. Start the service
  const startResult = startService();
  messages.push(startResult);

  // 5. Wait a moment for the service to start
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 6. Check if bridge is running
  const pid = getBridgePid();
  if (pid) {
    messages.push(`Bridge restarted (PID ${pid})`);
    messages.push(`Service will auto-start on boot.`);
  } else {
    messages.push("Warning: Bridge may not have started. Check logs.");
  }

  return messages.join("\n");
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let config: TelegramConfig | null = null;

  // Try to load config, show setup wizard if not found
  try {
    config = loadConfig();
  } catch {
    // Config not found, will show setup wizard
  }

  pi.registerTool({
    name: "telegram_send",
    label: "Telegram Send",
    description:
      "Send a message to the user's Telegram chat. Use this to notify the user of important results, completion of long tasks, or when you need their attention outside the terminal.",
    promptSnippet: "Send a Telegram notification to the user",
    promptGuidelines: [
      "Use telegram_send to notify the user via Telegram when a long-running task finishes, or when you need their attention outside the terminal.",
    ],
    parameters: Type.Object({
      message: Type.String({
        description: "Message text to send (max 4096 chars)",
      }),
      parse_mode: Type.Optional(
        Type.String({
          description:
            "Parse mode: 'MarkdownV2', 'HTML', or omit for plain text",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!config) {
        return {
          content: [{ type: "text", text: "Telegram not configured. Run /tg to set up." }],
          isError: true,
        };
      }

      const text = params.message.slice(0, 4096);
      const result = await sendTelegramMessage(
        config.botToken,
        config.chatId,
        text,
        params.parse_mode
      );

      if (result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Message sent to Telegram chat ${config.chatId}`,
            },
          ],
          details: {
            messageId: (result.result as { message_id?: number })?.message_id,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Failed to send Telegram message: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    },
  });

  pi.registerCommand("tg", {
    description: "Telegram management menu (or /tg <message> to send directly)",
    handler: async (args, ctx) => {
      // If no config, show setup wizard
      if (!config) {
        ctx.ui.notify("Telegram not configured. Starting setup wizard...", "info");
        config = await setupWizard(ctx);
        if (!config) return;
      }

      // If args provided, send message directly (backward compatible)
      if (args) {
        const result = await sendTelegramMessage(config.botToken, config.chatId, args);
        if (result.ok) {
          ctx.ui.notify("Sent to Telegram", "info");
        } else {
          ctx.ui.notify(`Failed: ${result.error}`, "error");
        }
        return;
      }

      // Show status first
      ctx.ui.notify("Checking bot status...", "info");
      const status = await checkBotStatus(config.botToken);
      const serviceStatus = getServiceStatus();
      ctx.ui.notify(`${status}\n\n${serviceStatus}`, "info");

      // Interactive menu
      const MENU_OPTIONS = [
        "发送测试消息",
        "重启 Bridge 服务",
        "停止 Bridge 服务",
        "查看 Bridge 日志",
        "检查配置",
        "卸载服务",
      ];

      const choice = await ctx.ui.select("Telegram 管理", MENU_OPTIONS);
      if (!choice) return;

      switch (choice) {
        case "发送测试消息": {
          const result = await sendTestMessage(config.botToken, config.chatId);
          ctx.ui.notify(result, result.includes("success") ? "info" : "error");
          break;
        }
        case "重启 Bridge 服务": {
          ctx.ui.notify("Restarting bridge and configuring auto-start...", "info");
          const result = await restartBridge();
          ctx.ui.notify(result, "info");
          break;
        }
        case "停止 Bridge 服务": {
          const result = stopBridge();
          ctx.ui.notify(result, result.includes("stopped") ? "info" : "error");
          break;
        }
        case "查看 Bridge 日志": {
          const logs = viewBridgeLogs();
          ctx.ui.notify(logs, "info");
          break;
        }
        case "检查配置": {
          const info = checkConfig(config);
          const serviceInfo = getServiceStatus();
          ctx.ui.notify(`${info}\n\n${serviceInfo}`, "info");
          break;
        }
        case "卸载服务": {
          const confirmed = await ctx.ui.confirm("卸载确认", "确定要卸载 Telegram Bridge 服务吗？这将停止服务并移除所有配置。");
          if (confirmed) {
            const result = uninstallAll();
            ctx.ui.notify(result, "info");
          }
          break;
        }
      }
    },
  });
}
