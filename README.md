# C2A-UI — Convert to Any (UI Fork)

> **This is a community fork of [p2r3/convert](https://github.com/p2r3/convert) — the Convert to it! project.**  
> Upstream: https://github.com/p2r3/convert  
> Fork: https://github.com/Hamguy21/C2A-UI

---

![C2A-UI screenshot](https://github.com/user-attachments/assets/0ff54ae0-5f62-4f67-9bdd-1c2439aa752d)

**Truly universal browser-based file converter — no uploads, no servers, fully private.**

Most online file conversion tools only handle files within the same medium (images→images, videos→videos) and require uploading your files to a remote server. C2A-UI inherits the original project's goal: convert **anything to anything**, entirely on-device, in your browser.

For a semi-technical overview of the upstream project, see: https://youtu.be/btUbcsTbVA8

## About this fork

C2A-UI (Convert 2 Any — UI) is a fork of [p2r3/convert](https://github.com/p2r3/convert) that tracks the upstream project closely. The fork is kept up to date with upstream and currently shares the same codebase.

### What's the same as upstream

- All 70+ file format handlers (FFmpeg, ImageMagick, Pandoc, SQLite, MIDI, 3D models, game formats, and more)
- The `TraversionGraph` engine that chains multiple handlers together to find multi-step conversion routes automatically
- Simple/Advanced mode UI toggle
- Docker, Electron, and Bun/Vite deployment options
- Full conversion test suite

### What this fork tracks / may diverge on

| Area | Status |
|---|---|
| Core conversion engine | In sync with upstream |
| Handler library (70+ formats) | In sync with upstream |
| UI layout and styling | In sync with upstream |
| Docker/Nginx config | In sync with upstream |

> This fork was created to serve as a base for UI-focused experimentation and community contributions. Issues and PRs that may not fit the upstream's scope can be explored here.

---

## Usage

You can run this fork locally (see [Deployment](#deployment) below), or visit the upstream hosted version at [convert.to.it](https://convert.to.it/).

1. Click the large file-drop area to select your file(s), or drag and drop them onto the window. You can also paste from the clipboard.
2. An input format is automatically detected. You can refine it using the search box or by clicking a different format button.
3. Select an output format from the **Convert to:** list.
4. Click **Convert**!
5. After processing, the converted file will be downloaded automatically. A summary popup shows the conversion path used (e.g. `mp4 → png → bmp`).

**Simple vs Advanced mode:**  
Toggle using the button in the top-right corner. In Simple mode, each format appears once. In Advanced mode, you see which specific handler (tool) handles each format, so you can pick the exact converter for each step.

## Issues

Ever since the YouTube video released, we've been getting spammed with issues suggesting the addition of all kinds of niche file formats. To keep things organized, I've decided to specify what counts as a valid issue and what doesn't.

> [!IMPORTANT]
> **SIMPLY ASKING FOR A FILE FORMAT TO BE ADDED IS NOT A MEANINGFUL ISSUE!**

There are thousands of file formats out there. It can take hours to add support for just one. The math is simple - we can't possibly support every single file. As such, simply listing your favorite file formats is not helpful. We already know that there are formats we don't support, we don't need tickets to tell us that.

When suggesting a file format, you must _at minimum_:
- Make sure that there isn't already an issue about the same thing, and that we don't already support the format.
- Explain what you expect the conversion to be like (what medium is it converting to/from). It's important to note here that simply parsing the underlying data is _not sufficient_. Imagine if we only treated SVG images as raw XML data and didn't support converting them to raster images - that would defeat the point. In other words, try to avoid crude "binary waterfalls".
- Provide links to existing browser-based solutions if possible, or at the very least a reference for implementing the format, and make sure the license is compatible with GPL-2.0.

If this seems like a lot, please remember - a developer will have to do 100x more work to actually implement the format. Doing a bit of research not only saves them precious time, it also weeds out "unserious" proposals that would only bloat our to-do list.

**If you're submitting a bug report,** you only need to do step 1 - check if the problem isn't already reported by someone else. Bug reports are generally quite important otherwise.

Though please note, "converting X to Y doesn't work" is **not** a bug report.  However, "converting X to Y works but not how I expected" likely **is** a bug report.

## Deployment

### Local development (Bun + Vite)

1. Clone this repository ***WITH SUBMODULES***. You can use `git clone --recursive https://github.com/Hamguy21/C2A-UI` for that. Omitting submodules will leave you missing a few dependencies.
2. Install [Bun](https://bun.sh/).
3. Run `bun install` to install dependencies.
4. Run `bun run dev` to start the development server.

For a production-style build, run `npm run build`. That now builds the app and generates `dist/cache.json` automatically.

When Vite starts in development, it also kicks off `buildCache.js` against the live dev server. If `dist/cache.json` is missing, it gets created. If it already exists, it is reused as a seed and each handler cache entry is checked against a registry hash, so new or changed handlers are refreshed automatically.

`buildCache.js` now warms stale handlers across multiple Puppeteer pages by default. You can override the fan-out with `--workers <count>` if you want to tune cache-build parallelism.

_The following steps are optional, but recommended for performance:_

When you first open the page without a fresh cache, it may need to warm missing handler entries before the format lists are fully available. If you open the console, you'll see logs for any missing or refreshed cache entries.

To regenerate the cache manually, run `npm run cache:build`.

If `dist/cache.json` already exists, the cache build step reuses it as a seed. That means only handlers missing from the cache, or handlers whose source changed, need to initialize during regeneration.

`printSupportedFormatCache()` still exists for debugging, but you should not need to manually copy its output during normal development.

If cache generation hits handler or page errors, the build writes `dist/cache-report.json` and `dist/cache-errors.log`. On the next app load, the UI shows a popup pointing to the log file.

If you run into issues where your changes seem to not be applying, try disabling this cache.

### Docker (prebuilt image)

Docker compose files live in the `docker/` directory, so run compose with `-f` from the repository root:

```bash
docker compose -f docker/docker-compose.yml up -d
```

Alternatively download the `docker-compose.yml` separately and start it by executing `docker compose up -d` in the same directory.

This runs the container on `http://localhost:8080/convert/`.

### Docker (local build for development)

Use the override file to build the image locally:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml up --build -d
```

Or use the repo script, which resolves `VITE_COMMIT_SHA` in a cross-platform way:

```bash
npm run docker
```

The first Docker build is expected to be slow because Chromium and related system packages are installed in the build stage (needed for puppeteer in `buildCache.js`). Later builds are usually much faster due to Docker layer caching.

The local Docker image builds the app and pre-generates `dist/cache.json`, so the container starts with the supported-format cache already available.

## MCP

This repository now includes a stdio MCP server so remote tools and LLMs can inspect supported formats, plan conversion routes, and run conversions through the real browser-based app.

### Start the server

1. Start MCP in development mode: `npm run mcp:start`

By default, the MCP server now starts its own Vite dev server automatically and connects to that live app.

If you already have the Docker container running on `http://127.0.0.1:8080/convert/`, start MCP against that served app with `node ./mcp/server.mjs --docker`.

When `convert_files` is called without `outputDir`, MCP now writes outputs into a sibling `converted/` folder next to the first input file instead of writing back into the source file's directory root.

If you want to use the built app in `dist/` instead, run:

1. Build the app: `npm run build`
2. Start MCP against `dist/`: `npm run mcp:dist`

The server launches a headless browser against either Vite or the built app and exposes these MCP tools:

- `list_handlers`: lists registered handlers and their format counts.
- `list_formats`: lists supported formats, optionally filtered by direction, handler, MIME type, or format name.
- `detect_input_formats`: ranks likely input formats for a file path, MIME type, or extension.
- `list_output_options`: lists only the reachable output formats for a specific input, ranked by route quality.
- `plan_conversion`: finds a conversion path between two formats using the app's traversal logic.
- `preview_conversion_result`: previews the best route, output metadata, and route characteristics without writing files.
- `explain_conversion`: explains the selected route in plain language, including tools used and likely tradeoffs.
- `suggest_conversion`: recommends a short ranked list of output targets for a loose goal like `editable`, `text`, or `png`.
- `convert_files`: converts one or more local files and writes the outputs to disk.
- `smart_convert`: performs a best-effort conversion directly from a loose user goal such as `png`, `text`, or `openable on Windows`.

### VS Code MCP config

There is also a ready-to-use config in `.vscode/mcp.json` that runs `node ./mcp/server.mjs --vite`, so MCP comes up with Vite automatically without relying on shell-specific `npm` spawning behavior.

### LM Studio on Windows

LM Studio usually starts MCP servers outside the repository root, so a relative script path like `./mcp/server.mjs` can fail with "not found" even though the file exists.

Use one of these launcher scripts instead:

- `mcp/lmstudio-docker.cmd`
- `mcp/lmstudio-vite.cmd`

If you want LM Studio to launch the MCP server through Docker instead of a host file path, build the MCP image first:

```bash
npm run docker:mcp:build
```

Then use a config entry like this:

```json
"convert-to-it": {
  "command": "docker",
  "args": [
    "run",
    "--rm",
    "-i",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    "CONVERT_DOCKER_APP_URL=http://host.docker.internal:8080/convert",
    "convert-mcp:dev"
  ],
  "env": {}
}
```

That Docker-based MCP entry expects the web app container to already be running on `http://127.0.0.1:8080/convert/`.

The `convert-mcp` Docker image is optional. Docker Compose now starts only the main `convert` web app container by default; build or run `convert-mcp:dev` only when an external MCP client specifically needs a Docker-launched stdio server.

On Windows, point LM Studio at the wrapper script by using the absolute path to your local clone. For example:

```text
C:\path\to\convert\mcp\lmstudio-docker.cmd
```

Use the Vite-backed launcher instead if you want MCP to start its own dev server:

```text
C:\path\to\convert\mcp\lmstudio-vite.cmd
```

If LM Studio asks for arguments, leave them empty when using these wrapper scripts.

> [!NOTE]
> The MCP server depends on Puppeteer. The development path does not require `dist/`; only `npm run mcp:dist` does.

## Contributing

The best way to contribute is by adding support for new file formats (duh). If you don't have a format to add but are eager to help, take a look at our issues. There are plenty of suggestions there.

Here's how adding a format works:

### Creating a handler

Each "tool" used for conversion has to be normalized to a standard form - effectively a "wrapper" that abstracts away the internal processes. These wrappers are available in [src/handlers](src/handlers/).

There is now a working example handler at [src/handlers/examples/exampleTextHandler.ts](src/handlers/examples/exampleTextHandler.ts). It is intentionally placed in a nested folder so it does **not** get auto-registered into the app.

If you want to add a real handler, copy that file into a new **top-level** file under [src/handlers](src/handlers/) and then rename it for your format/tool.

The current workflow is:

1. Create a new top-level file in [src/handlers](src/handlers/), for example `myFormat.ts`.
2. Export a valid `FormatHandler` from that file. A default-exported class is the simplest pattern.
3. Give the handler a unique `name`, fill `supportedFormats` in `init()`, and implement `doConvert()`.
4. Run `npm run build:app` to confirm the file is discovered by the lazy manifest generator in [vite.config.js](vite.config.js).
5. Run `npm run build` before shipping if you want to regenerate `dist/cache.json` as well.

Important details:

- Only **top-level** files in [src/handlers](src/handlers/) are auto-discovered. Nested folders are safe for examples, vendored assets, helper code, and submodules.
- A handler will not appear in the format lists unless `init()` publishes at least one `supportedFormats` entry.
- The app now warms handlers that are **missing** from the supported-format cache before building the UI lists, so newly added handlers still appear even if an older cache exists.

Below is a minimal starting point based on the example handler:

```ts
// file: myFormat.ts

import { FormatDefinition, type FileData, type FileFormat, type FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";

const MY_FORMAT = new FormatDefinition(
  "My Custom Text Format",
  "myfmt",
  "myfmt",
  "text/x-my-format",
  "text"
);

class myFormatHandler implements FormatHandler {
  public name = "myFormat";
  public supportedFormats?: FileFormat[];
  public ready = false;

  async init () {
    this.supportedFormats = [
      CommonFormats.TEXT.builder("text")
        .markLossless()
        .allowFrom(true)
        .allowTo(true),
      MY_FORMAT.builder("myfmt")
        .markLossless()
        .allowFrom(true)
        .allowTo(true)
    ];
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    return inputFiles.map(file => {
      const source = new TextDecoder().decode(file.bytes);

      return {
        name: `${file.name.split(".").slice(0, -1).join(".") || file.name}.${outputFormat.extension}`,
        bytes: new TextEncoder().encode(source)
      };
    });
  }
}

export default myFormatHandler;
```

For more details on how all of these components work, refer to the doc comments in [src/FormatHandler.ts](src/FormatHandler.ts). You can also take a look at existing handlers to get a more practical example.

There are a few additional things that I want to point out in particular:

- Pay attention to the naming system. If your tool is called `dummy`, then the class should be called `dummyHandler`, and the file should be called `dummy.ts`.
- The handler is responsible for setting the output file's name. This is done to allow for flexibility in rare cases where the _full_ file name matters. Of course, in most cases, you'll only have to swap the file extension.
- The handler is also responsible for ensuring that any byte buffers that enter or exit the handler _do not get mutated_. If necessary, clone the buffer by wrapping it in `new Uint8Array()`.
- When handling MIME types, run them through [normalizeMimeType](src/normalizeMimeType.ts) first. One file can have multiple valid MIME types, which isn't great when you're trying to match them algorithmically.
- When implementing/suggesting a new file format, please treat the file as the media that it represents, not the data that it contains. For example, if you were making an SVG handler, you should treat the file as an _image_, not as XML. In other words, avoid simple "binary waterfalls", as they're not semantically meaningful.

### Testing

This project currently uses two levels of tests:

- Broad project-level tests live directly in `test/` (for example graph traversal and end-to-end conversion smoke tests).
- Optional handler-specific unit tests live in `test/handlers/`, using the file name pattern `<handlerName>.test.ts`. These are a good fit for handlers with meaningful parsing, serialization, or file-naming logic that is hard to exercise reliably through traversal alone.

Not every handler needs a dedicated unit test, but handlers with non-trivial custom internal logic may benefit from having one.

### Adding dependencies

If your tool requires an external dependency (which it likely does), there are currently two well-established ways of going about this:

- If it's an `npm` package, just install it to the project like you normally would.
- If it's a Git repository, add it as a submodule to [src/handlers](src/handlers).
- If neither of the above are available, then **as a last resort**, you may create a folder with the required assets under `src/handlers/handlerName`.

**Please try to avoid CDNs (Content Delivery Networks).** They're really cool on paper, but they don't work well with TypeScript, and each one introduces a tiny bit of instability. For a project that leans heavily on external dependencies, those bits of instability can add up fast.

- If you need to load a WebAssembly binary (or similar), add its path to [vite.config.js](vite.config.js) and target it under `/convert/wasm/`. **Do not link to node_modules**.

### AI Usage Policy

If you intend to use an LLM, agent-enabled IDE, or other AI-driven tool for your contribution, please follow these guidelines:

- Clearly state that you've used an LLM, ideally in your pull request's description. Do not attempt to pass off an AI's work as your own. I'm far more likely to accept a pull request that openly admits to using AI than one that does but pretends it doesn't. Transparency helps the maintainer (me) know what to keep an eye out for (e.g. hallucinations), and helps you keep yourself in check.
- Do not overindulge. If your contribution is trivial or simple enough to be written by hand, please opt to write it by hand. This is especially true if it's your first contribution. You're much more likely to retain knowledge and understanding about architectural details if you've familiarized yourself with the process hands-on first.
- Keep the scope to things you _could_ do by hand. LLMs are tools, and this is a community-driven project. Orchestrating an AI to write logic that you don't fully comprehend is not only reckless for a community project, it's also disrespectful towards human contributors who took the time to research their additions. In other words, there should _never_ be a scenario where you _need_ an LLM.
- Explain what you (and the LLM) are doing, in a way that makes it clear that you understand the changes you're making.

Not adhering to these rules will likely get your pull request closed.

I figure that there are people who'd prefer if I merged _zero_ AI-written code, but I believe that's simply not feasible. Just from a code integrity perspective, it's much safer to be transparent about AI usage and define clear guidelines than to make it a taboo and risk people "sneaking in" unvetted AI code. Making things illegal doesn't stop everyone from doing those things - some will still do them, just in secret and with less oversight.
