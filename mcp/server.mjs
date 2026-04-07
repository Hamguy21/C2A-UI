import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

import mime from "mime";
import puppeteer from "puppeteer";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distDir = path.join(repoRoot, "dist");
const useVite = process.argv.includes("--vite");
const useDocker = process.argv.includes("--docker");
const dockerAppUrl = process.env.CONVERT_DOCKER_APP_URL || "http://127.0.0.1:8080/convert";

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a dev-server port."));
        return;
      }
      const { port } = address;
      server.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForHttp(url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok || response.status === 304) return;
    } catch {
      // wait and retry
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function buildSelection(prefix, args) {
  return {
    mime: args[`${prefix}Mime`] || undefined,
    format: args[`${prefix}Format`] || undefined,
    extension: args[`${prefix}Extension`] || undefined,
    internal: args[`${prefix}Internal`] || undefined,
    handler: args[`${prefix}Handler`] || undefined
  };
}

function formatSelectionProvided(selection) {
  return Object.values(selection).some(Boolean);
}

function summarizePath(pathEntries) {
  return pathEntries.map(entry => `${entry.handler}:${entry.format.format}`).join(" -> ");
}

function buildFileContext(args) {
  return {
    fileName: args.fileName || (args.filePath ? path.basename(args.filePath) : undefined),
    mimeType: args.mime || (args.filePath ? mime.getType(args.filePath) || undefined : undefined)
  };
}

async function stopChildProcessTree(childProcess) {
  if (!childProcess?.pid) return;

  if (process.platform === "win32") {
    await new Promise(resolve => {
      const killer = spawn("taskkill", ["/pid", String(childProcess.pid), "/T", "/F"], {
        stdio: "ignore"
      });

      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }

  if (childProcess.exitCode !== null || childProcess.killed) return;

  await new Promise(resolve => {
    const finalize = () => resolve();
    childProcess.once("exit", finalize);
    childProcess.kill("SIGTERM");

    const forceKillTimer = setTimeout(() => {
      if (childProcess.exitCode === null && !childProcess.killed) {
        childProcess.kill("SIGKILL");
      }
      resolve();
    }, 3000);

    forceKillTimer.unref?.();
  });
}

class BrowserBackedConvertApp {
  #server;
  #port;
  #browser;
  #page;
  #appUrl;
  #viteProcess;

  async ensureReady() {
    if (this.#page) return;

    if (useVite) {
      const port = await getAvailablePort();
      const viteCommand = process.platform === "win32"
        ? {
            command: "cmd.exe",
            args: ["/d", "/s", "/c", `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`]
          }
        : {
            command: "npm",
            args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
          };

      this.#viteProcess = spawn(viteCommand.command, viteCommand.args, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"]
      });

      this.#viteProcess.stdout?.on("data", chunk => {
        process.stderr.write(String(chunk));
      });
      this.#viteProcess.stderr?.on("data", chunk => {
        process.stderr.write(String(chunk));
      });

      this.#appUrl = `http://127.0.0.1:${port}/convert`;
      await waitForHttp(`${this.#appUrl}/`);
    } else if (useDocker) {
      this.#appUrl = dockerAppUrl;
      await waitForHttp(`${this.#appUrl}/`);
    } else {
      const distIndexPath = path.join(distDir, "index.html");
      try {
        await stat(distIndexPath);
      } catch {
        throw new Error("Missing dist/index.html. Run `npm run build` before starting the MCP server, or use `npm run mcp:start` for Vite-backed startup.");
      }

      this.#server = createServer(async (request, response) => {
        try {
          const url = new URL(request.url || "/convert/index.html", "http://127.0.0.1");
          const relativePath = (
            url.pathname.startsWith("/convert/")
              ? url.pathname.replace(/^\/convert\/?/, "")
              : url.pathname.replace(/^\//, "")
          ) || "index.html";
          const resolvedPath = path.resolve(distDir, relativePath);
          if (!resolvedPath.startsWith(distDir)) {
            response.writeHead(403);
            response.end("Forbidden");
            return;
          }

          let file;
          try {
            file = await readFile(resolvedPath);
          } catch (error) {
            if (relativePath === "cache.json") {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end("[]");
              return;
            }
            throw error;
          }

          response.writeHead(200, {
            "Content-Type": mime.getType(resolvedPath) || "application/octet-stream"
          });
          response.end(file);
        } catch {
          response.writeHead(404);
          response.end("Not Found");
        }
      });

      await new Promise((resolve, reject) => {
        this.#server.once("error", reject);
        this.#server.listen(0, "127.0.0.1", () => resolve());
      });

      const address = this.#server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to determine local app server address.");
      }
      this.#port = address.port;
      this.#appUrl = `http://127.0.0.1:${this.#port}/convert`;
    }

    this.#browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    this.#page = await this.#browser.newPage();

    this.#page.on("console", msg => {
      if (msg.type() === "error") {
        console.error(`[convert-page] ${msg.text()}`);
      }
    });

    await this.#page.goto(`${this.#appUrl}/${useVite ? "" : "index.html"}`, {
      waitUntil: "domcontentloaded"
    });
    await this.#page.waitForFunction(() => window.convertApi?.ready === true, { timeout: 120000 });
  }

  async listHandlers() {
    await this.ensureReady();
    return this.#page.evaluate(() => window.convertApi.listHandlers());
  }

  async listFormats() {
    await this.ensureReady();
    return this.#page.evaluate(() => window.convertApi.listFormats());
  }

  async detectInputFormats(args) {
    await this.ensureReady();
    return this.#page.evaluate((payload) => window.convertApi.detectInputFormats(payload), args);
  }

  async listOutputOptions(args) {
    await this.ensureReady();
    return this.#page.evaluate((payload) => window.convertApi.listOutputOptions(payload), args);
  }

  async planConversion(args) {
    await this.ensureReady();
    return this.#page.evaluate((payload) => window.convertApi.planConversion(payload), args);
  }

  async previewConversionResult(args) {
    await this.ensureReady();
    return this.#page.evaluate((payload) => window.convertApi.previewConversionResult(payload), args);
  }

  async explainConversion(args) {
    await this.ensureReady();
    return this.#page.evaluate((payload) => window.convertApi.explainConversion(payload), args);
  }

  async suggestConversion(args) {
    await this.ensureReady();
    return this.#page.evaluate((payload) => window.convertApi.suggestConversion(payload), args);
  }

  async convert(args) {
    await this.ensureReady();
    return this.#page.evaluate((payload) => window.convertApi.convert(payload), args);
  }

  async close() {
    await this.#page?.close().catch(() => {});
    await this.#browser?.close().catch(() => {});
    await stopChildProcessTree(this.#viteProcess);

    if (this.#server) {
      await new Promise(resolve => this.#server.close(() => resolve()));
    }
  }
}

const browserApp = new BrowserBackedConvertApp();
const server = new McpServer({
  name: "convert-to-it",
  version: "0.1.0"
});

server.tool(
  "list_handlers",
  "List conversion handlers exposed by Convert to it.",
  {
    onlyReady: z.boolean().optional()
  },
  async ({ onlyReady }) => {
    const handlers = await browserApp.listHandlers();
    const filtered = onlyReady ? handlers.filter(handler => handler.ready) : handlers;
    return {
      content: [{
        type: "text",
        text: JSON.stringify(filtered, null, 2)
      }]
    };
  }
);

server.tool(
  "list_formats",
  "List supported formats and optionally filter by direction, handler, MIME type, or format name.",
  {
    direction: z.enum(["from", "to", "either"]).optional(),
    handler: z.string().optional(),
    mime: z.string().optional(),
    format: z.string().optional(),
    category: z.string().optional()
  },
  async ({ direction = "either", handler, mime: mimeType, format, category }) => {
    const formats = await browserApp.listFormats();
    const filtered = formats.filter(entry => {
      if (direction === "from" && !entry.from) return false;
      if (direction === "to" && !entry.to) return false;
      if (handler && entry.handler !== handler) return false;
      if (mimeType && entry.mime !== mimeType) return false;
      if (format && entry.format !== format) return false;
      if (category) {
        const categories = Array.isArray(entry.category) ? entry.category : [entry.category || entry.mime.split("/")[0]];
        if (!categories.includes(category)) return false;
      }
      return true;
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(filtered, null, 2)
      }]
    };
  }
);

server.tool(
  "detect_input_formats",
  "Rank likely input formats for a file path, MIME type, or extension.",
  {
    filePath: z.string().optional(),
    fileName: z.string().optional(),
    mime: z.string().optional(),
    limit: z.number().int().positive().max(50).optional()
  },
  async ({ filePath, fileName, mime: mimeType, limit = 10 }) => {
    const detectedFileName = fileName || (filePath ? path.basename(filePath) : undefined);
    if (!detectedFileName) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Provide filePath or fileName." }, null, 2)
        }],
        isError: true
      };
    }

    const detectedMime = mimeType || (filePath ? mime.getType(filePath) || undefined : undefined);
    const matches = await browserApp.detectInputFormats({ fileName: detectedFileName, mimeType: detectedMime });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(matches.slice(0, limit), null, 2)
      }]
    };
  }
);

server.tool(
  "list_output_options",
  "List reachable output formats for a specific input file or input selection, ranked by route quality.",
  {
    filePath: z.string().optional(),
    fileName: z.string().optional(),
    mime: z.string().optional(),
    fromMime: z.string().optional(),
    fromFormat: z.string().optional(),
    fromExtension: z.string().optional(),
    fromInternal: z.string().optional(),
    fromHandler: z.string().optional(),
    simpleMode: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional()
  },
  async (args) => {
    const from = buildSelection("from", args);
    const fileContext = buildFileContext(args);

    if (!formatSelectionProvided(from) && !fileContext.fileName) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Provide filePath, fileName, or an explicit input selection." }, null, 2)
        }],
        isError: true
      };
    }

    const result = await browserApp.listOutputOptions({
      from: formatSelectionProvided(from) ? from : undefined,
      fileName: fileContext.fileName,
      mimeType: fileContext.mimeType,
      simpleMode: args.simpleMode ?? true,
      limit: args.limit ?? 25
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }],
      isError: !result.ok
    };
  }
);

server.tool(
  "plan_conversion",
  "Plan a conversion path between two supported formats.",
  {
    fromMime: z.string().optional(),
    fromFormat: z.string().optional(),
    fromExtension: z.string().optional(),
    fromInternal: z.string().optional(),
    fromHandler: z.string().optional(),
    toMime: z.string().optional(),
    toFormat: z.string().optional(),
    toExtension: z.string().optional(),
    toInternal: z.string().optional(),
    toHandler: z.string().optional(),
    simpleMode: z.boolean().optional()
  },
  async (args) => {
    const from = buildSelection("from", args);
    const to = buildSelection("to", args);
    if (!formatSelectionProvided(from) || !formatSelectionProvided(to)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Both input and output selections must include at least one selector." }, null, 2)
        }],
        isError: true
      };
    }

    const result = await browserApp.planConversion({ from, to, simpleMode: args.simpleMode ?? true });
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }],
      isError: !result.ok
    };
  }
);

server.tool(
  "preview_conversion_result",
  "Preview the best conversion route and expected output metadata without writing files.",
  {
    filePath: z.string().optional(),
    fileName: z.string().optional(),
    mime: z.string().optional(),
    fromMime: z.string().optional(),
    fromFormat: z.string().optional(),
    fromExtension: z.string().optional(),
    fromInternal: z.string().optional(),
    fromHandler: z.string().optional(),
    toMime: z.string().optional(),
    toFormat: z.string().optional(),
    toExtension: z.string().optional(),
    toInternal: z.string().optional(),
    toHandler: z.string().optional(),
    simpleMode: z.boolean().optional()
  },
  async (args) => {
    const from = buildSelection("from", args);
    const to = buildSelection("to", args);
    const fileContext = buildFileContext(args);

    if (!formatSelectionProvided(to)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Output selection must include at least one selector." }, null, 2)
        }],
        isError: true
      };
    }

    if (!formatSelectionProvided(from) && !fileContext.fileName) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Provide filePath, fileName, or an explicit input selection." }, null, 2)
        }],
        isError: true
      };
    }

    const result = await browserApp.previewConversionResult({
      from: formatSelectionProvided(from) ? from : undefined,
      to,
      fileName: fileContext.fileName,
      mimeType: fileContext.mimeType,
      simpleMode: args.simpleMode ?? true
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }],
      isError: !result.ok
    };
  }
);

server.tool(
  "explain_conversion",
  "Explain the best available conversion route in plain language, including backend choices and tradeoffs.",
  {
    filePath: z.string().optional(),
    fileName: z.string().optional(),
    mime: z.string().optional(),
    fromMime: z.string().optional(),
    fromFormat: z.string().optional(),
    fromExtension: z.string().optional(),
    fromInternal: z.string().optional(),
    fromHandler: z.string().optional(),
    toMime: z.string().optional(),
    toFormat: z.string().optional(),
    toExtension: z.string().optional(),
    toInternal: z.string().optional(),
    toHandler: z.string().optional(),
    simpleMode: z.boolean().optional()
  },
  async (args) => {
    const from = buildSelection("from", args);
    const to = buildSelection("to", args);
    const fileContext = buildFileContext(args);

    if (!formatSelectionProvided(to)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Output selection must include at least one selector." }, null, 2)
        }],
        isError: true
      };
    }

    if (!formatSelectionProvided(from) && !fileContext.fileName) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Provide filePath, fileName, or an explicit input selection." }, null, 2)
        }],
        isError: true
      };
    }

    const result = await browserApp.explainConversion({
      from: formatSelectionProvided(from) ? from : undefined,
      to,
      fileName: fileContext.fileName,
      mimeType: fileContext.mimeType,
      simpleMode: args.simpleMode ?? true
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }],
      isError: !result.ok
    };
  }
);

server.tool(
  "suggest_conversion",
  "Suggest a ranked set of output targets for a loose goal like 'editable', 'text', 'png', or 'openable on Windows'.",
  {
    filePath: z.string().optional(),
    fileName: z.string().optional(),
    mime: z.string().optional(),
    fromMime: z.string().optional(),
    fromFormat: z.string().optional(),
    fromExtension: z.string().optional(),
    fromInternal: z.string().optional(),
    fromHandler: z.string().optional(),
    goal: z.string().min(1),
    simpleMode: z.boolean().optional(),
    limit: z.number().int().positive().max(25).optional()
  },
  async (args) => {
    const from = buildSelection("from", args);
    const fileContext = buildFileContext(args);

    if (!formatSelectionProvided(from) && !fileContext.fileName) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Provide filePath, fileName, or an explicit input selection." }, null, 2)
        }],
        isError: true
      };
    }

    const result = await browserApp.suggestConversion({
      from: formatSelectionProvided(from) ? from : undefined,
      fileName: fileContext.fileName,
      mimeType: fileContext.mimeType,
      goal: args.goal,
      simpleMode: args.simpleMode ?? true,
      limit: args.limit ?? 5
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }],
      isError: !result.ok
    };
  }
);

server.tool(
  "convert_files",
  "Convert one or more local files using the browser-backed conversion engine and write outputs to disk. Defaults to a sibling converted/ folder when outputDir is omitted.",
  {
    inputPaths: z.array(z.string()).min(1),
    outputDir: z.string().optional(),
    fromMime: z.string().optional(),
    fromFormat: z.string().optional(),
    fromExtension: z.string().optional(),
    fromInternal: z.string().optional(),
    fromHandler: z.string().optional(),
    toMime: z.string().optional(),
    toFormat: z.string().optional(),
    toExtension: z.string().optional(),
    toInternal: z.string().optional(),
    toHandler: z.string().optional(),
    simpleMode: z.boolean().optional()
  },
  async (args) => {
    const from = buildSelection("from", args);
    const to = buildSelection("to", args);

    if (!formatSelectionProvided(to)) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: "Output selection must include at least one selector." }, null, 2)
        }],
        isError: true
      };
    }

    if (!formatSelectionProvided(from)) {
      const guessedExtension = path.extname(args.inputPaths[0]).replace(/^\./, "");
      const guessedMime = mime.getType(args.inputPaths[0]) || undefined;
      if (guessedExtension) from.extension = guessedExtension;
      if (guessedMime) from.mime = guessedMime;
    }

    const files = await Promise.all(args.inputPaths.map(async inputPath => ({
      name: path.basename(inputPath),
      bytes: Array.from(new Uint8Array(await readFile(inputPath)))
    })));

    const result = await browserApp.convert({
      files,
      from,
      to,
      simpleMode: args.simpleMode ?? true
    });

    if (!result.ok || !result.outputs) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }],
        isError: true
      };
    }

    const outputDir = args.outputDir || path.join(path.dirname(args.inputPaths[0]), "converted");
    await mkdir(outputDir, { recursive: true });

    const writtenFiles = [];
    for (const output of result.outputs) {
      const outputPath = path.join(outputDir, output.name);
      await writeFile(outputPath, Buffer.from(output.bytes));
      writtenFiles.push(outputPath);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          writtenFiles,
          path: result.path,
          pathSummary: result.path ? summarizePath(result.path) : undefined
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "smart_convert",
  "Convert one or more local files directly from a loose goal such as 'png', 'text', 'editable', or 'openable on Windows'.",
  {
    inputPaths: z.array(z.string()).min(1),
    outputDir: z.string().optional(),
    goal: z.string().min(1),
    simpleMode: z.boolean().optional()
  },
  async (args) => {
    const firstInputPath = args.inputPaths[0];
    const suggestionResult = await browserApp.suggestConversion({
      fileName: path.basename(firstInputPath),
      mimeType: mime.getType(firstInputPath) || undefined,
      goal: args.goal,
      simpleMode: args.simpleMode ?? true,
      limit: 1
    });
    const chosenSuggestion = suggestionResult.suggestions?.[0];

    if (!suggestionResult.ok || !chosenSuggestion) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(suggestionResult.ok ? { ok: false, error: "No suitable conversion suggestion was found." } : suggestionResult, null, 2)
        }],
        isError: true
      };
    }

    const files = await Promise.all(args.inputPaths.map(async inputPath => ({
      name: path.basename(inputPath),
      bytes: Array.from(new Uint8Array(await readFile(inputPath)))
    })));

    const result = await browserApp.convert({
      files,
      from: chosenSuggestion.inputSelection,
      to: chosenSuggestion.outputSelection,
      simpleMode: args.simpleMode ?? true
    });

    if (!result.ok || !result.outputs) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }],
        isError: true
      };
    }

    const outputDir = args.outputDir || path.join(path.dirname(firstInputPath), "converted");
    await mkdir(outputDir, { recursive: true });

    const writtenFiles = [];
    for (const output of result.outputs) {
      const outputPath = path.join(outputDir, output.name);
      await writeFile(outputPath, Buffer.from(output.bytes));
      writtenFiles.push(outputPath);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          goal: args.goal,
          chosenSuggestion,
          writtenFiles,
          path: result.path,
          pathSummary: result.path ? summarizePath(result.path) : undefined
        }, null, 2)
      }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await browserApp.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);