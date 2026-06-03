/**
 * pi Telegram Bridge
 *
 * Runs a Telegram bot that forwards messages to a pi coding agent (via RPC)
 * and sends responses back to Telegram.
 *
 * Usage:
 *   npm install
 *   npm start
 *
 * Config: telegram-config.json (gitignored)
 *   { "botToken": "...", "chatId": "..." }
 */

import { Bot, webhookCallback } from "grammy";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { platform, arch } from "node:os";

// --- Platform Detection ---

function detectPiBinary(): string {
  const os = platform();
  const architecture = arch();

  // Map os.platform() to build.sh format
  let platformOs: string;
  switch (os) {
    case "linux": platformOs = "linux"; break;
    case "darwin": platformOs = "darwin"; break;
    case "win32": platformOs = "windows"; break;
    default: throw new Error(`Unsupported OS: ${os}`);
  }

  // Map os.arch() to build.sh format
  let platformArch: string;
  switch (architecture) {
    case "x64": platformArch = "x64"; break;
    case "arm64": platformArch = "arm64"; break;
    default: throw new Error(`Unsupported architecture: ${architecture}`);
  }

  const packageDir = `pi-${platformOs}-${platformArch}`;
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  const binaryPath = resolve(scriptDir, "..", "dist", packageDir, "bin", "pi");

  if (!existsSync(binaryPath)) {
    throw new Error(
      `Pi binary not found at: ${binaryPath}\n` +
      `Expected package: ${packageDir}\n` +
      `Run build.sh first to compile the binary.`
    );
  }

  console.log(`[pi] detected platform: ${packageDir}`);
  console.log(`[pi] binary path: ${binaryPath}`);
  return binaryPath;
}

// --- Config ---

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function loadConfig(): TelegramConfig {
  const candidates = [
    resolve(dirname(new URL(import.meta.url).pathname), "telegram-config.json"),
    resolve(process.env.HOME ?? "~", ".pi", "agent", "extensions", "telegram-config.json"),
    resolve(process.cwd(), "telegram-config.json"),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const config = JSON.parse(raw) as TelegramConfig;
      if (config.botToken && config.chatId) return config;
    } catch {}
  }

  throw new Error("telegram-config.json not found. Create it with botToken and chatId.");
}

const config = loadConfig();
const sessionsDir = resolve(process.env.HOME ?? "~", ".pi", "agent", "sessions", "telegram");
const sessionPath = resolve(sessionsDir, `chat-${config.chatId}.jsonl`);

class StreamSender {
  private chatId: number;
  private bot: Bot;
  private draftId = Math.floor(Math.random() * 1000000) + 1;
  private mode: "draft" | "edit" | "detecting" = "detecting";
  private messageId: number | null = null;
  private lastText = "";
  
  constructor(chatId: number, bot: Bot) {
    this.chatId = chatId;
    this.bot = bot;
  }
  
  async sendUpdate(text: string) {
    if (!text.trim()) return;
    this.lastText = text;
    
    const formattedText = markdownToHtml(text);
    
    if (this.mode === "detecting") {
      try {
        // Try calling sendMessageDraft
        await this.bot.api.raw.makeRequest("sendMessageDraft", {
          chat_id: this.chatId,
          draft_id: this.draftId,
          text: formattedText,
          parse_mode: "HTML"
        });
        this.mode = "draft";
        return;
      } catch (err) {
        console.log("[tg] sendMessageDraft not supported or failed, falling back to editMessageText:", err);
        this.mode = "edit";
        // Send initial message for edit mode
        const msg = await this.bot.api.sendMessage(this.chatId, formattedText, { parse_mode: "HTML" });
        this.messageId = msg.message_id;
        return;
      }
    }
    
    if (this.mode === "draft") {
      try {
        await this.bot.api.raw.makeRequest("sendMessageDraft", {
          chat_id: this.chatId,
          draft_id: this.draftId,
          text: formattedText,
          parse_mode: "HTML"
        });
      } catch (err) {
        console.error("[tg] draft update error:", err);
      }
    } else if (this.mode === "edit" && this.messageId !== null) {
      try {
        await this.bot.api.editMessageText(this.chatId, this.messageId, formattedText, { parse_mode: "HTML" });
      } catch (err) {
        const isNotModified = err instanceof Error && err.message.includes("message is not modified");
        if (!isNotModified) {
          console.error("[tg] edit update error:", err);
        }
      }
    }
  }
  
  async finalize(text: string) {
    const chunks = splitMessage(text || this.lastText || "(no response)", 4096);
    
    if (this.mode === "draft") {
      for (const chunk of chunks) {
        const formatted = markdownToHtml(chunk);
        await this.bot.api.sendMessage(this.chatId, formatted, { parse_mode: "HTML" });
      }
    } else if (this.mode === "edit" && this.messageId !== null) {
      const firstChunkFormatted = markdownToHtml(chunks[0] || "(no response)");
      try {
        await this.bot.api.editMessageText(this.chatId, this.messageId, firstChunkFormatted, { parse_mode: "HTML" });
      } catch (err) {
        const isNotModified = err instanceof Error && err.message.includes("message is not modified");
        if (!isNotModified) {
          try {
            await this.bot.api.sendMessage(this.chatId, firstChunkFormatted, { parse_mode: "HTML" });
          } catch (err2) {
            console.error("[tg] fallback finalize send error:", err2);
          }
        }
      }
      
      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        const formatted = markdownToHtml(chunks[i]);
        await this.bot.api.sendMessage(this.chatId, formatted, { parse_mode: "HTML" });
      }
    } else {
      // Fallback
      for (const chunk of chunks) {
        const formatted = markdownToHtml(chunk);
        await this.bot.api.sendMessage(this.chatId, formatted, { parse_mode: "HTML" });
      }
    }
  }
}

// --- pi RPC Client ---

type RpcEvent = Record<string, unknown> & { type: string };

class PiRpcClient {
  public bot: Bot | null = null;
  public onStreamUpdate: ((text: string) => void) | null = null;
  private lastStreamTime = 0;
  private streamTimeout: ReturnType<typeof setTimeout> | null = null;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pendingPrompt: {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  } | null = null;
  private responseText = "";
  private isProcessing = false;
  private queue: Array<{ message: string; chatId: number }> = [];
  private thinkingBlockDepth = 0;
  private typingInterval: ReturnType<typeof setInterval> | null = null;

  // Start sending typing action periodically
  startTyping(chatId: number, bot: Bot) {
    this.stopTyping();
    // Send immediately, then every 4 seconds (Telegram typing action lasts ~5 seconds)
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    this.typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
  }

  // Stop sending typing action
  stopTyping() {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  // Filter thinking blocks from response text
  filterThinkingBlocks(text: string): string {
    // Remove <thinking>...</thinking> blocks (may span multiple lines)
    // Also handle nested thinking blocks
    let result = text;

    // Remove complete thinking blocks
    while (result.includes('<thinking>') && result.includes('</thinking>')) {
      const start = result.indexOf('<thinking>');
      const end = result.indexOf('</thinking>', start);
      if (end === -1) break;
      result = result.slice(0, start) + result.slice(end + '</thinking>'.length);
    }

    // Remove unclosed thinking block at the end (if still processing)
    const unclosedStart = result.lastIndexOf('<thinking>');
    if (unclosedStart !== -1 && !result.includes('</thinking>', unclosedStart)) {
      result = result.slice(0, unclosedStart);
    }

    // Clean up extra whitespace
    result = result.replace(/\n{3,}/g, '\n\n').trim();

    return result;
  }

  private triggerStreamUpdate(text: string) {
    if (!this.onStreamUpdate) return;
    const now = Date.now();
    const elapsed = now - this.lastStreamTime;
    
    if (this.streamTimeout) {
      clearTimeout(this.streamTimeout);
      this.streamTimeout = null;
    }
    
    if (elapsed >= 800) {
      this.lastStreamTime = now;
      this.onStreamUpdate(text);
    } else {
      this.streamTimeout = setTimeout(() => {
        this.lastStreamTime = Date.now();
        this.onStreamUpdate?.(text);
      }, 800 - elapsed);
    }
  }

  start() {
    this.spawnProcess();
  }

  private spawnProcess() {
    console.log("[pi] spawning pi rpc process...");
    const piBinary = detectPiBinary();
    mkdirSync(dirname(sessionPath), { recursive: true });
    this.proc = spawn(
      piBinary,
      ["--mode", "rpc", "--session", sessionPath],
      { stdio: ["pipe", "pipe", "pipe"], cwd: process.env.HOME || "~" }
    );

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[pi:stderr]", text);
    });
    this.proc.on("exit", (code) => {
      console.log(`[pi] process exited with code ${code}`);
      this.proc = null;
      if (this.pendingPrompt) {
        this.pendingPrompt.reject(new Error(`pi exited with code ${code}`));
        this.pendingPrompt = null;
      }
      setTimeout(() => this.spawnProcess(), 3000);
    });

    console.log("[pi] rpc process started");
  }

  private onStdout(chunk: Buffer) {
    const decoder = new StringDecoder("utf8");
    this.buffer += decoder.write(chunk);

    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;

      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;

      try {
        this.handleEvent(JSON.parse(line) as RpcEvent);
      } catch {
        console.error("[pi] bad json:", line.slice(0, 200));
      }
    }
  }

  private handleEvent(event: RpcEvent) {
    switch (event.type) {
      case "message_update": {
        const ase = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (ase?.type === "text_delta") {
          const delta = (ase.delta as string) ?? "";

          // Track thinking block depth
          const openCount = (delta.match(/<thinking>/g) || []).length;
          const closeCount = (delta.match(/<\/thinking>/g) || []).length;
          this.thinkingBlockDepth += openCount - closeCount;

          // Only accumulate text if we're not inside a thinking block
          if (this.thinkingBlockDepth <= 0) {
            this.thinkingBlockDepth = 0;
            // Filter any remaining thinking tags
            const filtered = delta.replace(/<\/?thinking>/g, '');
            if (filtered.trim()) {
              this.responseText += filtered;
              this.triggerStreamUpdate(this.responseText);
            }
          }
        }
        break;
      }
      case "tool_execution_start": {
        const name = event.toolName as string;
        const args = event.args as Record<string, unknown> | undefined;
        if (name === "bash") {
          const cmd = (args?.command as string ?? "").slice(0, 100);
          this.responseText += `\n🔧 **bash**\n\`\`\`\n${cmd}\n\`\`\`\n`;
        } else if (name === "read") {
          const path = args?.path as string ?? "";
          this.responseText += `\n📖 **read** \`${path}\`\n`;
        }
        this.triggerStreamUpdate(this.responseText);
        break;
      }
      case "agent_end": {
        if (this.streamTimeout) {
          clearTimeout(this.streamTimeout);
          this.streamTimeout = null;
        }
        if (this.pendingPrompt) {
          const text = this.responseText.trim() || "(no response)";
          this.pendingPrompt.resolve(text);
          this.pendingPrompt = null;
        }
        this.processQueue();
        break;
      }
      case "response": {
        if (event.success === false) {
          console.error("[pi] command error:", event.error);
        }
        break;
      }
    }
  }

  async sendPrompt(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error("pi process not running"));
        return;
      }
      this.responseText = "";
      this.thinkingBlockDepth = 0;
      this.pendingPrompt = { resolve, reject };
      this.proc.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
    });
  }

  enqueue(message: string, chatId: number) {
    this.queue.push({ message, chatId });
    if (!this.isProcessing) this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const { message, chatId } = this.queue.shift()!;
    
    const sender = this.bot ? new StreamSender(chatId, this.bot) : null;
    if (sender) {
      this.onStreamUpdate = (text) => {
        const filtered = this.filterThinkingBlocks(text);
        sender.sendUpdate(filtered).catch(() => {});
      };
    }
    
    try {
      const response = await this.sendPrompt(message);
      this.stopTyping();
      const filtered = this.filterThinkingBlocks(response);
      if (sender) {
        await sender.finalize(filtered);
      } else {
        this.onResponse?.(filtered, chatId);
      }
    } catch (err) {
      this.stopTyping(); // Stop typing on error
      const errText = `Error: ${err instanceof Error ? err.message : String(err)}`;
      if (sender) {
        await sender.finalize(errText);
      } else {
        this.onResponse?.(errText, chatId);
      }
    } finally {
      this.onStreamUpdate = null;
      this.isProcessing = false;
      if (this.queue.length > 0) this.processQueue();
    }
  }

  onResponse: ((text: string, chatId: number) => void) | null = null;

  stop() {
    this.stopTyping();
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

// --- Telegram HTML Formatting ---

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function convertMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table: line starts with | and next line is separator (|---|)
    if (
      lines[i].trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())
    ) {
      // Parse header
      const headers = lines[i]
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);

      // Skip separator line
      i += 2;

      // Parse data rows
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i]
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean);
        rows.push(cells);
        i++;
      }

      if (headers.length > 0 && rows.length > 0) {
        const tableLines: string[] = [];
        const colCount = headers.length;

        if (colCount === 2) {
          tableLines.push(`**${headers[0]} / ${headers[1]}**`);
          for (const row of rows) {
            const key = row[0] || "";
            const val = row[1] || "";
            tableLines.push(`- **${key}**: ${val}`);
          }
        } else {
          for (const row of rows) {
            const rowHeader = row[0] || "";
            tableLines.push(`**${headers[0]}: ${rowHeader}**`);
            for (let c = 1; c < colCount; c++) {
              const colHeader = headers[c] || `Column ${c + 1}`;
              const colValue = row[c] || "";
              tableLines.push(`  - *${colHeader}*: ${colValue}`);
            }
          }
        }
        result.push(tableLines.join("\n"));
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

function markdownToHtml(text: string): string {
  // 1. Split by code blocks
  const parts = text.split("```");
  const processedParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // Inside a code block
      const block = parts[i];
      const firstNewLine = block.indexOf("\n");
      let lang = "";
      let code = block;
      if (firstNewLine !== -1) {
        const potentialLang = block.slice(0, firstNewLine).trim();
        // Check if it looks like a language tag
        if (potentialLang && /^[a-zA-Z0-9_-]+$/.test(potentialLang)) {
          lang = potentialLang;
          code = block.slice(firstNewLine + 1);
        }
      }
      
      // Escape HTML special characters inside code block
      const escapedCode = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
      if (lang) {
        processedParts.push(`<pre><code class="language-${lang}">${escapedCode}</code></pre>`);
      } else {
        processedParts.push(`<pre>${escapedCode}</pre>`);
      }
    } else {
      // Regular text block — extract tables first, protect them, then format the rest
      const rawBlock = parts[i];

      // 1. Convert markdown tables to <pre> BEFORE any other processing
      const converted = convertMarkdownTables(rawBlock);

      // 2. Protect <pre>...</pre> blocks with placeholders
      const TABLE_PH = "\x00TBL_";
      const savedTables: string[] = [];
      let tblIdx = 0;
      let block = converted.replace(/<pre>[\s\S]*?<\/pre>/g, (m) => {
        savedTables.push(m);
        return `${TABLE_PH}${tblIdx++}\x00`;
      });

      // 3. Escape HTML special characters (only on non-table parts)
      block = block
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      // 4. Process lines for block-level elements (headings, lists)
      const lines = block.split("\n");
      const processedLines = lines.map((line) => {
        // Headings
        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
          return `<b>${headingMatch[2]}</b>`;
        }

        // Unordered lists
        const listMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
        if (listMatch) {
          const indent = listMatch[1] || "";
          return `${indent}• ${listMatch[2]}`;
        }

        // Ordered lists
        const orderedListMatch = line.match(/^(\s*)(\d+\.)\s+(.*)$/);
        if (orderedListMatch) {
          const indent = orderedListMatch[1] || "";
          return `${indent}${orderedListMatch[2]} ${orderedListMatch[3]}`;
        }

        return line;
      });

      let formattedBlock = processedLines.join("\n");

      // 5. Inline formatting (bold, italic, links, inline code)
      const inlineParts = formattedBlock.split("`");
      const processedInlineParts: string[] = [];

      for (let j = 0; j < inlineParts.length; j++) {
        if (j % 2 === 1) {
          processedInlineParts.push(`<code>${inlineParts[j]}</code>`);
        } else {
          let inlineText = inlineParts[j];
          inlineText = inlineText.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
          inlineText = inlineText.replace(/__(.*?)__/g, "<b>$1</b>");
          inlineText = inlineText.replace(/\*(.*?)\*/g, "<i>$1</i>");
          inlineText = inlineText.replace(/_(.*?)_/g, "<i>$1</i>");
          inlineText = inlineText.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
          processedInlineParts.push(inlineText);
        }
      }

      // 6. Restore <pre> table blocks
      let result = processedInlineParts.join("");
      result = result.replace(/\x00TBL_(\d+)\x00/g, (_, idx) => savedTables[parseInt(idx)]);

      processedParts.push(result);
    }
  }

  return processedParts.join("");
}

// --- Telegram Bot with 409 retry ---

async function startBot(pi: PiRpcClient): Promise<void> {
  const bot = new Bot(config.botToken);
  pi.bot = bot;

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    if (String(chatId) !== config.chatId) {
      console.log(`[tg] ignored message from chat ${chatId}`);
      return;
    }

    const text = ctx.message.text.trim();
    if (!text) return;

    if (text === "/ping") { await ctx.reply("pong"); return; }
    if (text === "/status") { await ctx.reply(`Queue: ${pi["queue"].length} pending`); return; }
    if (text === "/abort") {
      pi.stopTyping(); // Stop typing animation
      if (pi["proc"]?.stdin?.writable) {
        pi["proc"].stdin.write(JSON.stringify({ type: "abort" }) + "\n");
        await ctx.reply("Abort signal sent.");
      } else {
        await ctx.reply("pi process not running.");
      }
      return;
    }
    if (text === "/compact") {
      if (pi["proc"]?.stdin?.writable) {
        pi["proc"].stdin.write(JSON.stringify({ type: "compact" }) + "\n");
        await ctx.reply("Compaction command sent.");
      } else {
        await ctx.reply("pi process not running.");
      }
      return;
    }
    if (text === "/clear") {
      await ctx.reply("Clearing session and starting a new one...");
      pi.stop();
      try {
        if (existsSync(sessionPath)) {
          const backupPath = sessionPath.replace(/\.jsonl$/, `.backup-${Date.now()}.jsonl`);
          renameSync(sessionPath, backupPath);
        }
      } catch (err) {
        console.error("[tg] failed to clear session:", err);
      }
      pi.start();
      await ctx.reply("New session started.");
      return;
    }

    console.log(`[tg] <- ${text.slice(0, 100)}`);
    // Start typing animation
    pi.startTyping(chatId, bot);
    pi.enqueue(text, chatId);
  });

  pi.onResponse = async (text: string, chatId: number) => {
    // Stop typing animation
    pi.stopTyping();

    // Final filter pass to remove any remaining thinking blocks
    const filteredText = pi.filterThinkingBlocks(text);

    if (!filteredText.trim()) {
      await bot.api.sendMessage(chatId, "(No response)");
      return;
    }

    console.log(`[tg] -> ${filteredText.slice(0, 100)}`);
    for (const chunk of splitMessage(filteredText, 4096)) {
      try {
        // Try to send with HTML format
        const formattedChunk = markdownToHtml(chunk);
        await bot.api.sendMessage(chatId, formattedChunk, { parse_mode: "HTML" });
      } catch (err) {
        // If HTML fails, send as plain text
        console.error("[tg] html formatting error, sending as plain text:", err);
        try { await bot.api.sendMessage(chatId, chunk); }
        catch (err2) { console.error("[tg] send error:", err2); }
      }
    }
  };

  // Force takeover: aggressive fixed-interval retry to win the polling slot
  // morph uses max_concurrency:3 with exponential backoff, so we use short fixed delay
  // Use manual polling loop instead of bot.start()
  // bot.start() can exit silently in non-interactive environments
  await bot.init();
  console.log(`[tg] bot initialized as @${bot.botInfo?.username}`);
  console.log(`[tg] listening for messages from chat ${config.chatId}`);

  let offset = 0;
  let pollCount = 0;
  while (true) {
    try {
      pollCount++;
      console.log(`[tg] polling (attempt ${pollCount}, offset ${offset})...`);
      const updates = await bot.api.getUpdates({
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });

      console.log(`[tg] got ${updates.length} update(s)`);

      for (const update of updates) {
        offset = update.update_id + 1;
        console.log(`[tg] processing update ${update.update_id}`);
        // Process update through grammy's handler system
        bot.handleUpdate(update);
      }
    } catch (err: unknown) {
      const is409 = err instanceof Error && err.message.includes("409");
      if (is409) {
        console.log(`[tg] polling conflict, retrying...`);
        await sleep(1000);
        continue;
      }
      console.error(`[tg] polling error:`, err);
      await sleep(5000);
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function checkBotStatus(token: string): Promise<void> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await resp.json() as { ok: boolean; result: { url: string; pending_update_count: number } };
    if (data.ok) {
      const { url, pending_update_count } = data.result;
      console.log(`[tg] webhook url: ${url || "(none)"}`);
      console.log(`[tg] pending updates: ${pending_update_count}`);
      if (url) {
        console.log("[tg] warning: webhook is set, deleting it before polling...");
        await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
      }
    }
  } catch (err) {
    console.error("[tg] failed to check webhook status:", err);
  }
}

async function main() {
  // Diagnostics
  console.log("[tg] checking bot status...");
  await checkBotStatus(config.botToken);

  const pi = new PiRpcClient();
  pi.start();

  const shutdown = () => {
    console.log("\n[bridge] shutting down...");
    pi.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive
  const keepAlive = setInterval(() => {
    console.log("[tg] heartbeat - bridge is alive");
  }, 30000);

  console.log("[tg] main: starting bot...");
  try {
    await startBot(pi);
    console.log("[tg] main: startBot returned unexpectedly");
  } catch (err) {
    console.error("[tg] main: startBot threw error:", err);
  } finally {
    clearInterval(keepAlive);
  }
  console.log("[tg] main: exiting");
}

process.on("unhandledRejection", (reason) => {
  console.error("[bridge] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[bridge] uncaught exception:", err);
});

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  process.exit(1);
});
