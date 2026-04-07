import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import tsconfigPaths from "vite-tsconfig-paths";

async function waitForUrlReady (url, timeoutMs = 180000) {
  const startTime = Date.now();

  while ((Date.now() - startTime) < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok || response.status === 304) {
        return true;
      }
    } catch {
      // Keep polling until the dev page is actually served.
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return false;
}

function supportedFormatCachePlugin () {
  let cacheBuildStarted = false;

  return {
    name: "supported-format-cache",
    configureServer (server) {
      server.middlewares.use("/convert/cache.json", async (_req, res, next) => {
        try {
          const cacheJSON = await readFile("dist/cache.json", "utf8");
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(cacheJSON);
          return;
        } catch {
          next();
        }
      });

      server.middlewares.use("/convert/cache-report.json", async (_req, res, next) => {
        try {
          const cacheReport = await readFile("dist/cache-report.json", "utf8");
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(cacheReport);
          return;
        } catch {
          next();
        }
      });

      server.httpServer?.once("listening", async () => {
        if (cacheBuildStarted) return;
        cacheBuildStarted = true;

        const address = server.httpServer?.address();
        if (!address || typeof address === "string") return;

        const devUrl = `http://127.0.0.1:${address.port}/convert/index.html`;
        const ready = await waitForUrlReady(devUrl);
        if (!ready) {
          console.warn(`Supported format cache build skipped because Vite never served ${devUrl}.`);
          return;
        }

        const cacheBuild = spawn(
          process.platform === "win32" ? "bun.exe" : "bun",
          [
            "run",
            "buildCache.js",
            "--minify",
            "--url",
            devUrl
          ],
          {
            cwd: process.cwd(),
            stdio: "inherit"
          }
        );

        cacheBuild.on("error", error => {
          console.warn(`Failed to start supported format cache build: ${error.message}`);
        });

        cacheBuild.on("exit", code => {
          if (code === 0) return;
          console.warn(`Supported format cache build exited with code ${code}.`);
        });
      });
    }
  };
}

async function buildHandlerSourceHashes () {
  const handlerDir = path.resolve("src/handlers");
  const entries = await readdir(handlerDir, { withFileTypes: true });
  const hashes = {};

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|js)$/.test(entry.name)) continue;
    if (/^index\.(ts|js)$/.test(entry.name)) continue;
    if (/\.worker\.(ts|js)$/.test(entry.name)) continue;

    const source = await readFile(path.join(handlerDir, entry.name), "utf8");
    hashes[`./${entry.name}`] = createHash("sha1").update(source).digest("hex").slice(0, 12);
  }

  return hashes;
}

function getPropertyNameText(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function parseHandlerManifestEntry(pathKey, sourceText) {
  const sourceFile = ts.createSourceFile(pathKey, sourceText, ts.ScriptTarget.Latest, true, pathKey.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const classMetadata = new Map();
  const variableMetadata = new Map();
  const manifestEntries = [];

  const readBooleanLiteral = (expression) => expression && (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword)
    ? expression.kind === ts.SyntaxKind.TrueKeyword
    : undefined;

  const readNumberLiteral = (expression) => expression && ts.isNumericLiteral(expression)
    ? Number(expression.text)
    : undefined;

  const readStringLiteral = (expression) => expression && ts.isStringLiteralLike(expression)
    ? expression.text
    : undefined;

  const exportClassManifest = (exportName, metadata) => {
    if (!metadata?.name) return;
    manifestEntries.push({
      path: pathKey,
      exportName,
      name: metadata.name,
      supportAnyInput: metadata.supportAnyInput ?? false,
      priority: metadata.priority ?? 0
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      const metadata = {};

      for (const member of statement.members) {
        if (!ts.isPropertyDeclaration(member) || !member.name) continue;
        const propertyName = getPropertyNameText(member.name);
        if (!propertyName) continue;

        if (propertyName === "name") {
          metadata.name = readStringLiteral(member.initializer);
        } else if (propertyName === "supportAnyInput") {
          metadata.supportAnyInput = readBooleanLiteral(member.initializer);
        } else if (propertyName === "priority") {
          metadata.priority = readNumberLiteral(member.initializer);
        }
      }

      classMetadata.set(statement.name.text, metadata);

      const isExported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (isExported) {
        exportClassManifest(isDefault ? "default" : statement.name.text, metadata);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const isExported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const identifier = declaration.name.text;
        const initializer = declaration.initializer;
        const metadata = {};

        if (
          ts.isCallExpression(initializer)
          && ts.isIdentifier(initializer.expression)
          && initializer.expression.text === "renameHandler"
        ) {
          metadata.name = readStringLiteral(initializer.arguments[0]);
          metadata.supportAnyInput = false;
          metadata.priority = 0;
        } else if (ts.isObjectLiteralExpression(initializer)) {
          for (const property of initializer.properties) {
            if (!ts.isPropertyAssignment(property) || !property.name) continue;
            const propertyName = getPropertyNameText(property.name);
            if (!propertyName) continue;

            if (propertyName === "name") {
              metadata.name = readStringLiteral(property.initializer);
            } else if (propertyName === "supportAnyInput") {
              metadata.supportAnyInput = readBooleanLiteral(property.initializer);
            } else if (propertyName === "priority") {
              metadata.priority = readNumberLiteral(property.initializer);
            }
          }
        }

        variableMetadata.set(identifier, metadata);
        if (isExported) {
          exportClassManifest(identifier, metadata);
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const exportIdentifier = statement.expression.text;
      exportClassManifest(
        "default",
        classMetadata.get(exportIdentifier) || variableMetadata.get(exportIdentifier)
      );
    }
  }

  return manifestEntries;
}

async function buildHandlerRegistryMetadata () {
  const handlerDir = path.resolve("src/handlers");
  const entries = await readdir(handlerDir, { withFileTypes: true });
  const hashes = {};
  const manifest = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|js)$/.test(entry.name)) continue;
    if (/^index\.(ts|js)$/.test(entry.name)) continue;
    if (/\.worker\.(ts|js)$/.test(entry.name)) continue;

    const sourceText = await readFile(path.join(handlerDir, entry.name), "utf8");
    const pathKey = `./${entry.name}`;
    hashes[pathKey] = createHash("sha1").update(sourceText).digest("hex").slice(0, 12);
    manifest.push(...parseHandlerManifestEntry(pathKey, sourceText));
  }

  return { hashes, manifest };
}

const handlerRegistryMetadata = await buildHandlerRegistryMetadata();

export default defineConfig({
  define: {
    __HANDLER_SOURCE_HASHES__: JSON.stringify(handlerRegistryMetadata.hashes),
    __HANDLER_MANIFEST__: JSON.stringify(handlerRegistryMetadata.manifest)
  },
  optimizeDeps: {
    exclude: [
      "@ffmpeg/ffmpeg",
      "@sqlite.org/sqlite-wasm",
      "@bokuweb/zstd-wasm"
    ]
  },
  base: "/convert/",
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@flo-audio/reflo/reflo_bg.wasm",
          dest: "wasm"
        },
        {
          src: "src/handlers/pandoc/pandoc.wasm",
          dest: "wasm"
        },
        {
          src: "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.*",
          dest: "wasm"
        },
        {
          src: "node_modules/@imagemagick/magick-wasm/dist/magick.wasm",
          dest: "wasm"
        },
        {
          src: "src/handlers/libopenmpt/libopenmpt.wasm",
          dest: "wasm"
        },
        {
          src: "src/handlers/libopenmpt/libopenmpt.js",
          dest: "wasm"
        },
        {
          src: "node_modules/js-synthesizer/externals/libfluidsynth-2.4.6.js",
          dest: "wasm"
        },
        {
          src: "node_modules/js-synthesizer/dist/js-synthesizer.js",
          dest: "wasm"
        },
        {
          src: "src/handlers/midi/TimGM6mb.sf2",
          dest: "wasm"
        },
        {
          src: "src/handlers/espeakng.js/js/espeakng.worker.js",
          dest: "js"
        },
        {
          src: "src/handlers/espeakng.js/js/espeakng.worker.data",
          dest: "js"
        },
        {
          src: "node_modules/pdf-parse/dist/pdf-parse/web/pdf.worker.mjs",
          dest: "js"
        },
        {
          src: "src/handlers/tarCompressed/liblzma.wasm",
          dest: "wasm"
        },
        {
          src: "node_modules/turbowarp-packager-browser/dist/scaffolding/*",
          dest: "js/turbowarp-scaffolding"
        },
        {
          src: "node_modules/7z-wasm/7zz.wasm",
          dest: "wasm"
        },
        {
          src: "node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
          dest: "wasm"
        },
        {
          src: "node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm",
          dest: "wasm"
        }
      ]
    }),
    supportedFormatCachePlugin(),
    tsconfigPaths()
  ]
});
