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
4. Run `bunx vite` to start the development server.

_The following steps are optional, but recommended for performance:_

When you first open the page, it'll take a while to generate the list of supported formats for each tool. If you open the console, you'll see it complaining a bunch about missing caches.

After this is done (indicated by a `Built initial format list` message in the console), use `printSupportedFormatCache()` to get a JSON string with the cache data. You can then save this string to `cache.json` to skip that loading screen on startup.

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

The first Docker build is expected to be slow because Chromium and related system packages are installed in the build stage (needed for puppeteer in `buildCache.js`). Later builds are usually much faster due to Docker layer caching.

## Contributing

The best way to contribute is by adding support for new file formats (duh). If you don't have a format to add but are eager to help, take a look at our issues. There are plenty of suggestions there.

Here's how adding a format works works:

### Creating a handler

Each "tool" used for conversion has to be normalized to a standard form - effectively a "wrapper" that abstracts away the internal processes. These wrappers are available in [src/handlers](src/handlers/).

Below is a super barebones handler that does absolutely nothing. You can use this as a starting point for adding a new format:

```ts
// file: dummy.ts

import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";

class dummyHandler implements FormatHandler {

  public name: string = "dummy";
  public supportedFormats?: FileFormat[];
  public ready: boolean = false;

  async init () {
    this.supportedFormats = [
      // Example PNG format, with both input and output disabled
      CommonFormats.PNG.builder("png")
        .markLossless()
        .allowFrom(false)
        .allowTo(false),

      // Alternatively, if you need a custom format, define it like so:
      {
        name: "CompuServe Graphics Interchange Format (GIF)",
        format: "gif",
        extension: "gif",
        mime: "image/gif",
        from: false,
        to: false,
        internal: "gif",
        category: ["image", "video"],
        lossless: false
      },
    ];
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];
    return outputFiles;
  }

}

export default dummyHandler;
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
