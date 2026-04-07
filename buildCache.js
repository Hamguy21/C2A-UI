import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { availableParallelism } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

const cliArgs = process.argv.slice(2);
const minify = cliArgs.includes("--minify");
const urlFlagIndex = cliArgs.indexOf("--url");
const workerFlagIndex = cliArgs.indexOf("--workers");
const appUrl = urlFlagIndex >= 0 ? cliArgs[urlFlagIndex + 1] : undefined;
const outputPath = cliArgs.filter((arg, index) => {
  if (arg === "--minify" || arg === "--url" || arg === "--workers") return false;
  if (urlFlagIndex >= 0 && index === urlFlagIndex + 1) return false;
  if (workerFlagIndex >= 0 && index === workerFlagIndex + 1) return false;
  return true;
})[0] || "dist/cache.json";
const requestedWorkerCount = Number.parseInt(workerFlagIndex >= 0 ? cliArgs[workerFlagIndex + 1] ?? "" : "", 10);
const cacheWorkerCount = Math.max(
  1,
  Number.isFinite(requestedWorkerCount)
    ? requestedWorkerCount
    : Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)))
);
const outputDir = path.dirname(outputPath);
const reportPath = path.join(outputDir, "cache-report.json");
const logPath = path.join(outputDir, "cache-errors.log");
const outputFile = Bun.file(outputPath);
let existingCacheJSON = null;
if (await outputFile.exists()) {
  existingCacheJSON = await outputFile.text();
}

await mkdir(outputDir, { recursive: true });

const errorLines = [];
const describePath = (filePath) => path.relative(process.cwd(), filePath).replaceAll("\\", "/") || filePath.replaceAll("\\", "/");
const reportError = (scope, message) => {
  const entry = `[${new Date().toISOString()}] ${scope}: ${message}`;
  errorLines.push(entry);
  console.error(entry);
};

async function writeCacheBuildReport (status, message) {
  if (errorLines.length > 0) {
    await Bun.write(logPath, `${errorLines.join("\n")}\n`);
  } else {
    await rm(logPath, { force: true }).catch(() => {});
  }

  await Bun.write(reportPath, JSON.stringify({
    status,
    message,
    logFile: errorLines.length > 0 ? describePath(logPath) : null,
    errorCount: errorLines.length,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

const seedCacheJSON = existingCacheJSON ?? "[]";
await Bun.write(outputPath, seedCacheJSON);
console.log(`Seeded supported format cache at ${outputPath}.`);

async function getAvailablePort () {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.unref();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("Failed to allocate a local cache-build port."));
        return;
      }

      socket.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForPageUrl (url, timeoutMs = 180000) {
  const startTime = Date.now();

  while ((Date.now() - startTime) < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok || response.status === 304) {
        return;
      }
    } catch {
      // Retry until the dev server is reachable.
    }

    await Bun.sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function normalizeCachePayload (cacheValue) {
  if (Array.isArray(cacheValue)) {
    return {
      schemaVersion: 1,
      handlers: cacheValue
        .filter(entry => Array.isArray(entry) && entry.length === 2)
        .map(([name, formats]) => ({ name, version: null, formats }))
    };
  }

  if (cacheValue && typeof cacheValue === "object" && Array.isArray(cacheValue.handlers)) {
    return {
      schemaVersion: typeof cacheValue.schemaVersion === "number" ? cacheValue.schemaVersion : 2,
      handlers: cacheValue.handlers
        .filter(entry => entry && typeof entry.name === "string" && Array.isArray(entry.formats))
        .map(entry => ({
          name: entry.name,
          version: typeof entry.version === "string" ? entry.version : null,
          formats: entry.formats
        }))
    };
  }

  return {
    schemaVersion: 2,
    handlers: []
  };
}

function buildManualCacheWarmUrl (url, workerIndex) {
  const workerUrl = new URL(url);
  workerUrl.searchParams.set("cacheMode", "manual");
  workerUrl.searchParams.set("cacheWorker", String(workerIndex));
  return workerUrl.toString();
}

function splitIntoShards (items, shardCount) {
  const shards = Array.from({ length: shardCount }, () => []);

  for (let index = 0; index < items.length; index++) {
    shards[index % shardCount].push(items[index]);
  }

  return shards.filter(shard => shard.length > 0);
}

async function createCacheWorkerPage (browser, url, label) {
  const page = await browser.newPage();
  page.on("pageerror", error => {
    reportError(`${label}:pageerror`, error.stack || error.message);
  });
  page.on("console", msg => {
    const text = msg.text();
    const messageType = msg.type();

    if (messageType === "error") {
      reportError(`${label}:console:error`, text);
      return;
    }

    if (messageType === "warning" && text.startsWith("Failed to refresh cache for handler")) {
      reportError(`${label}:cache-refresh`, text);
      return;
    }

    if (
      text.startsWith("Cache miss for formats of handler")
      || text.startsWith("Refreshing stale supported format cache for handler")
      || text.startsWith("Updated supported format cache for")
      || text === "Cache warmup API ready."
      || text === "Built initial format list."
    ) {
      console.log(text);
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.convertApi?.ready === true, { timeout: 300000 });
  return page;
}

let server = null;
let pageUrl = appUrl;
let browser = null;

try {
  if (!pageUrl) {
    const port = await getAvailablePort();
    server = Bun.serve({
      async fetch (req) {
        const path = new URL(req.url).pathname.replace("/convert/", "") || "index.html";
        if (path === "cache.json") {
          return new Response(seedCacheJSON, {
            headers: {
              "content-type": "application/json; charset=utf-8"
            }
          });
        }
        if (path === "cache-report.json") {
          return new Response(JSON.stringify({
            status: "ok",
            message: "Cache build in progress.",
            logFile: null,
            errorCount: 0
          }), {
            headers: {
              "content-type": "application/json; charset=utf-8"
            }
          });
        }
        const file = Bun.file(`${__dirname}/dist/${path}`.replaceAll("..", ""));
        if (!(await file.exists())) return new Response("Not Found", { status: 404 });
        return new Response(file);
      },
      port
    });
    pageUrl = `http://127.0.0.1:${port}/convert/index.html`;
  }

  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  await waitForPageUrl(pageUrl);
  const controlPage = await createCacheWorkerPage(
    browser,
    buildManualCacheWarmUrl(pageUrl, 0),
    "worker-0"
  );

  const staleHandlers = await controlPage.evaluate(() => window.convertApi.listStaleHandlers());
  const effectiveWorkerCount = Math.max(1, Math.min(cacheWorkerCount, staleHandlers.length || 1));
  const shards = splitIntoShards(staleHandlers.map(handler => handler.name), effectiveWorkerCount);
  const payload = await controlPage.evaluate(() => window.convertApi.getSupportedFormatCachePayload());
  const payloadMap = new Map(payload.handlers.map(entry => [entry.name, entry]));

  if (shards.length > 0) {
    console.log(`Warming ${staleHandlers.length} handler cache entr${staleHandlers.length === 1 ? "y" : "ies"} across ${shards.length} page${shards.length === 1 ? "" : "s"}.`);
  }

  const workerPages = [controlPage];
  for (let workerIndex = 1; workerIndex < shards.length; workerIndex++) {
    workerPages.push(
      await createCacheWorkerPage(
        browser,
        buildManualCacheWarmUrl(pageUrl, workerIndex),
        `worker-${workerIndex}`
      )
    );
  }

  const shardResults = await Promise.all(shards.map((handlerNames, shardIndex) => (
    workerPages[shardIndex].evaluate(async (names) => {
      return await window.convertApi.warmHandlers({ handlerNames: names });
    }, handlerNames)
  )));

  for (const result of shardResults) {
    for (const entry of result.updated) {
      payloadMap.set(entry.name, entry);
    }

    for (const failed of result.failed) {
      reportError("cache-refresh", `${failed.name}: ${failed.error}`);
    }
  }

  const mergedPayload = {
    schemaVersion: payload.schemaVersion,
    handlers: Array.from(payloadMap.values()).sort((left, right) => left.name.localeCompare(right.name))
  };

  const cacheJSON = minify === true
    ? JSON.stringify(mergedPayload)
    : JSON.stringify(mergedPayload, null, 2);

  await Bun.write(outputPath, cacheJSON);
  console.log(`Wrote supported format cache to ${outputPath}.`);

  if (errorLines.length > 0) {
    await writeCacheBuildReport("error", "Supported format cache generated with logged errors.");
    console.warn(`Supported format cache completed with ${errorLines.length} logged issue(s). See ${describePath(logPath)}.`);
  } else {
    await writeCacheBuildReport("ok", "Supported format cache generated successfully.");
  }
} catch (error) {
  reportError("fatal", error instanceof Error ? (error.stack || error.message) : String(error));
  await writeCacheBuildReport("error", "Supported format cache generation failed.");
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server?.stop();
}
