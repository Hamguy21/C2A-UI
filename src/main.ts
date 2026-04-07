import type { FileFormat, FileData, FormatHandler, ConvertPathNode } from "./FormatHandler.js";
import normalizeMimeType from "./normalizeMimeType.js";
import handlers from "./handlers";
import { TraversionGraph } from "./TraversionGraph.js";

/** Files currently selected for conversion */
let selectedFiles: File[] = [];
const SUPPORTED_FORMAT_CACHE_STORAGE_KEY = "convert-supported-format-cache-v2";
const SUPPORTED_FORMAT_CACHE_SCHEMA_VERSION = 2;
const SUPPORTED_FORMAT_REPORT_PATH = "cache-report.json";
const HANDLER_INIT_TIMEOUT_MS = 45000;
const CACHE_MODE = new URLSearchParams(window.location.search).get("cacheMode");
const IS_MANUAL_CACHE_WARM_MODE = CACHE_MODE === "manual";

type SupportedFormatCacheEntry = {
  name: string;
  version?: string | null;
  formats: FileFormat[];
};

type SupportedFormatCachePayload = {
  schemaVersion: number;
  handlers: SupportedFormatCacheEntry[];
};

type CacheBuildReport = {
  status?: "ok" | "error";
  message?: string;
  logFile?: string | null;
  errorCount?: number;
};

type McpConfigMode = "vite" | "docker";
/**
 * Whether to use "simple" mode.
 * - In **simple** mode, the input/output lists are grouped by file format.
 * - In **advanced** mode, these lists are grouped by format handlers, which
 *   requires the user to manually select the tool that processes the output.
 */
let simpleMode: boolean = true;

const MCP_CONFIG_STORAGE_KEY = "convert-mcp-config-mode";
const MCP_CONFIG_SNIPPETS: Record<McpConfigMode, string> = {
  vite: `"convert-to-it": {
  "type": "stdio",
  "command": "node",
  "args": [
    "./mcp/server.mjs",
    "--vite"
  ]
},`,
  docker: `"convert-to-it": {
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
},`
};

const ui = {
  fileInput: document.querySelector("#file-input") as HTMLInputElement,
  fileSelectArea: document.querySelector("#file-area") as HTMLDivElement,
  convertButton: document.querySelector("#convert-button") as HTMLButtonElement,
  selectionGraph: document.querySelector("#selection-graph") as SVGSVGElement,
  selectionEdge: document.querySelector("#selection-edge") as SVGPathElement,
  selectionEdgeGlow: document.querySelector("#selection-edge-glow") as SVGPathElement,
  modeToggleButton: document.querySelector("#mode-button") as HTMLButtonElement,
  repoLinksButton: document.querySelector("#repo-links-button") as HTMLButtonElement,
  repoLinksMenu: document.querySelector("#repo-links-menu") as HTMLDivElement,
  mcpCopyButton: document.querySelector("#mcp-copy-button") as HTMLButtonElement,
  mcpMenu: document.querySelector("#mcp-menu") as HTMLDivElement,
  modeDescription: document.querySelector("#mode-description") as HTMLParagraphElement,
  inputList: document.querySelector("#from-list") as HTMLDivElement,
  outputList: document.querySelector("#to-list") as HTMLDivElement,
  inputSearch: document.querySelector("#search-from") as HTMLInputElement,
  inputSearchClear: document.querySelector("#search-from-clear") as HTMLButtonElement,
  outputSearch: document.querySelector("#search-to") as HTMLInputElement,
  outputSearchClear: document.querySelector("#search-to-clear") as HTMLButtonElement,
  popupBox: document.querySelector("#popup") as HTMLDivElement,
  popupBackground: document.querySelector("#popup-bg") as HTMLDivElement
};

let pendingStartupPopupHtml: string | null = null;
let selectedMcpConfigMode: McpConfigMode = "vite";
let selectionGraphFrame: number | null = null;
let inputSearchLockedToSelectedFiles = false;
const preloadedHandlerBySide: Record<"from" | "to", string | null> = {
  from: null,
  to: null
};

function getMcpConfigText () {
  return MCP_CONFIG_SNIPPETS[selectedMcpConfigMode];
}

function updateMcpButtonUi () {
  ui.mcpCopyButton.textContent = `MCP ${selectedMcpConfigMode === "vite" ? "Vite" : "Docker"}`;
  ui.mcpCopyButton.setAttribute("aria-expanded", String(!ui.mcpMenu.hidden));

  for (const button of Array.from(ui.mcpMenu.querySelectorAll("button[data-mcp-mode]"))) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.dataset.selected = String(button.dataset.mcpMode === selectedMcpConfigMode);
  }
}

function setMcpMenuOpen (open: boolean) {
  ui.mcpMenu.hidden = !open;
  ui.mcpCopyButton.setAttribute("aria-expanded", String(open));
}

function setRepoMenuOpen (open: boolean) {
  ui.repoLinksMenu.hidden = !open;
  ui.repoLinksButton.setAttribute("aria-expanded", String(open));
}

function loadSelectedMcpConfigMode () {
  try {
    const storedMode = localStorage.getItem(MCP_CONFIG_STORAGE_KEY);
    if (storedMode === "vite" || storedMode === "docker") {
      selectedMcpConfigMode = storedMode;
    }
  } catch {
    // Ignore storage failures and keep the default mode.
  }
  updateMcpButtonUi();
}

function saveSelectedMcpConfigMode () {
  try {
    localStorage.setItem(MCP_CONFIG_STORAGE_KEY, selectedMcpConfigMode);
  } catch {
    // Ignore storage failures.
  }
}

async function copySelectedMcpConfig () {
  const mcpConfigText = getMcpConfigText();

  try {
    await navigator.clipboard.writeText(mcpConfigText);
    ui.mcpCopyButton.textContent = `Copied ${selectedMcpConfigMode === "vite" ? "Vite" : "Docker"}`;
    ui.mcpCopyButton.classList.add("copied");
    window.setTimeout(() => {
      ui.mcpCopyButton.classList.remove("copied");
      updateMcpButtonUi();
    }, 1800);
  } catch {
    window.showPopup(
      `<h2>Copy failed</h2><p>Paste this into the <b>servers</b> section of your <b>mcp.json</b> file:</p><pre>${escapeHtml(mcpConfigText)}</pre><button onclick="window.hidePopup()">OK</button>`
    );
  }
}

function escapeHtml (value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getHandlerCacheVersion (handler: FormatHandler) {
  return handler.cacheVersion ?? "";
}

function getHandlersNeedingCacheRefresh () {
  return handlers.filter(handler => {
    if (!window.supportedFormatCache.has(handler.name)) return true;

    const cachedVersion = window.supportedFormatCacheVersions.get(handler.name) ?? "";
    return cachedVersion !== getHandlerCacheVersion(handler);
  });
}

function getHandlersMissingCacheEntries () {
  return handlers.filter(handler => !window.supportedFormatCache.has(handler.name));
}

function getHandlerByName (handlerName: string) {
  return handlers.find(handler => handler.name === handlerName);
}

async function primeHandlerSelection (handler: FormatHandler) {
  try {
    await initHandlerWithTimeout(handler);
    if (handler.supportedFormats) {
      setSupportedFormatCacheEntry(handler, handler.supportedFormats);
      saveSupportedFormatCache();
    }
  } catch (error) {
    console.warn(`Failed to prime handler "${handler.name}" on selection.`, error);
  }
}

function preloadHandlerForSide (side: "from" | "to", handler: FormatHandler) {
  if (preloadedHandlerBySide[side] === handler.name) return;
  preloadedHandlerBySide[side] = handler.name;
  void primeHandlerSelection(handler);
}

async function refreshHandlerCacheEntries (handlerNames?: string[]) {
  const targetHandlers = handlerNames && handlerNames.length > 0
    ? handlerNames
      .map(getHandlerByName)
      .filter((handler): handler is FormatHandler => handler !== undefined)
    : getHandlersNeedingCacheRefresh();

  const updated: Array<{ name: string; version: string; formats: FileFormat[] }> = [];
  const failed: Array<{ name: string; version: string; error: string }> = [];

  for (const handler of targetHandlers) {
    const version = getHandlerCacheVersion(handler);
    const hasCachedFormats = window.supportedFormatCache.has(handler.name);

    if (hasCachedFormats) {
      console.warn(`Refreshing stale supported format cache for handler "${handler.name}".`);
    } else {
      console.warn(`Cache miss for formats of handler "${handler.name}".`);
    }

    try {
      await initHandlerWithTimeout(handler);
      if (!handler.supportedFormats) {
        throw new Error(`Handler "${handler.name}" did not publish supported formats.`);
      }

      setSupportedFormatCacheEntry(handler, handler.supportedFormats);
      updated.push({
        name: handler.name,
        version,
        formats: handler.supportedFormats
      });
      console.info(`Updated supported format cache for "${handler.name}".`);
    } catch (error) {
      console.warn(`Failed to refresh cache for handler "${handler.name}".`, error);
      failed.push({
        name: handler.name,
        version,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { updated, failed };
}

function setSupportedFormatCacheEntry (handler: FormatHandler, formats: FileFormat[]) {
  window.supportedFormatCache.set(handler.name, formats);
  window.supportedFormatCacheVersions.set(handler.name, getHandlerCacheVersion(handler));
  handler.supportedFormats = formats;
}

function serializeSupportedFormatCache (prettyPrint = true) {
  const payload: SupportedFormatCachePayload = {
    schemaVersion: SUPPORTED_FORMAT_CACHE_SCHEMA_VERSION,
    handlers: Array.from(window.supportedFormatCache.entries()).map(([name, formats]) => ({
      name,
      version: window.supportedFormatCacheVersions.get(name) ?? null,
      formats
    }))
  };

  return JSON.stringify(payload, null, prettyPrint ? 2 : 0);
}

function loadSupportedFormatCache (cacheValue: unknown, source: string) {
  const supportedFormatCache = new Map<string, FileFormat[]>();
  const supportedFormatCacheVersions = new Map<string, string>();

  if (Array.isArray(cacheValue)) {
    for (const entry of cacheValue) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [name, formats] = entry;
      if (typeof name !== "string" || !Array.isArray(formats)) continue;
      supportedFormatCache.set(name, formats as FileFormat[]);
    }
  } else if (
    cacheValue
    && typeof cacheValue === "object"
    && "schemaVersion" in cacheValue
    && "handlers" in cacheValue
    && Array.isArray((cacheValue as SupportedFormatCachePayload).handlers)
  ) {
    for (const entry of (cacheValue as SupportedFormatCachePayload).handlers) {
      if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.formats)) continue;
      supportedFormatCache.set(entry.name, entry.formats);
      if (typeof entry.version === "string") {
        supportedFormatCacheVersions.set(entry.name, entry.version);
      }
    }
  } else {
    console.warn(`Unsupported supported format cache payload from ${source}.`);
    return false;
  }

  window.supportedFormatCache = supportedFormatCache;
  window.supportedFormatCacheVersions = supportedFormatCacheVersions;
  console.info(`Loaded supported format cache from ${source}.`);
  return true;
}

async function loadSupportedFormatCacheReport () {
  try {
    const response = await fetch(SUPPORTED_FORMAT_REPORT_PATH, { cache: "no-store" });
    if (!response.ok) return;

    const report = await response.json() as CacheBuildReport;
    if (report.status !== "error") return;

    const countLabel = typeof report.errorCount === "number"
      ? ` (${report.errorCount} logged ${report.errorCount === 1 ? "issue" : "issues"})`
      : "";
    const logFile = escapeHtml(report.logFile || "dist/cache-errors.log");
    const message = escapeHtml(report.message || "The supported format cache was generated with logged errors.");

    pendingStartupPopupHtml = `<h2>Cache build reported errors</h2><p>${message}</p><p>See <b>${logFile}</b>${countLabel}.</p><button onclick="window.hidePopup()">OK</button>`;
  } catch (error) {
    console.warn("Failed to load supported format cache report.", error);
  }
}

function saveSupportedFormatCache () {
  try {
    localStorage.setItem(
      SUPPORTED_FORMAT_CACHE_STORAGE_KEY,
      serializeSupportedFormatCache(false)
    );
  } catch (error) {
    console.warn("Failed to persist supported format cache.", error);
  }
}

async function initHandlerWithTimeout (handler: FormatHandler) {
  let timeoutId: number | undefined;

  try {
    await Promise.race([
      handler.init(),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`Timed out initializing handler \"${handler.name}\".`));
        }, HANDLER_INIT_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function buildOptionLabel (format: FileFormat, handler: FormatHandler) {
  const formatDescriptor = format.format.toUpperCase();
  if (simpleMode) {
    const cleanName = format.name
      .split("(").join(")").split(")")
      .filter((_, i) => i % 2 === 0)
      .filter(c => c !== "")
      .join(" ");
    return `${formatDescriptor} - ${cleanName} (${format.mime})`;
  }

  return `${formatDescriptor} - ${format.name} (${format.mime})`;
}

function createOptionButton (
  optionIndex: number,
  format: FileFormat,
  handler: FormatHandler,
  listSide: "from" | "to",
  clickHandler: (event: Event) => void
) {
  const button = document.createElement("button");
  button.setAttribute("format-index", optionIndex.toString());
  button.setAttribute("mime-type", format.mime);
  button.dataset.listSide = listSide;

  const label = document.createElement("span");
  label.className = "format-option-label";
  label.appendChild(document.createTextNode(buildOptionLabel(format, handler)));
  button.appendChild(label);

  if (!simpleMode) {
    button.classList.add("format-option-advanced");

    const handlerBadge = document.createElement("span");
    handlerBadge.className = "format-option-handler";
    handlerBadge.appendChild(document.createTextNode(handler.name));
    button.appendChild(handlerBadge);
  }

  const node = document.createElement("span");
  node.className = `format-option-node format-option-node-${listSide}`;
  node.setAttribute("aria-hidden", "true");
  button.appendChild(node);

  button.onclick = clickHandler;
  return button;
}

function getOptionSelectionSnapshot (button: HTMLButtonElement | null) {
  if (!button) return null;

  const optionIndex = Number(button.getAttribute("format-index"));
  const option = allOptions[optionIndex];
  if (!option) return null;

  return {
    mime: option.format.mime,
    format: option.format.format,
    extension: option.format.extension,
    internal: option.format.internal,
    handler: option.handler.name
  };
}

function restoreSelectionSnapshot (list: HTMLDivElement, selection: ReturnType<typeof getOptionSelectionSnapshot>, direction: "from" | "to") {
  if (!selection) return;

  for (const button of Array.from(list.children)) {
    if (!(button instanceof HTMLButtonElement)) continue;
    const optionIndex = Number(button.getAttribute("format-index"));
    const option = allOptions[optionIndex];
    if (!option || !matchesRemoteSelection(option, selection, direction)) continue;
    button.classList.add("selected");
    return;
  }
}

function getSelectedListButton (list: HTMLDivElement) {
  const selected = list.querySelector("button.selected");
  return selected instanceof HTMLButtonElement ? selected : null;
}

function getButtonNodeAnchor (button: HTMLButtonElement, side: "from" | "to") {
  const node = button.querySelector(`.format-option-node-${side}`);
  if (!(node instanceof HTMLElement)) return null;

  const rect = node.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  return {
    x: rect.left + window.scrollX + rect.width / 2,
    y: rect.top + window.scrollY + rect.height / 2
  };
}

function updateSelectionGraph () {
  selectionGraphFrame = null;

  const fromButton = getSelectedListButton(ui.inputList);
  const toButton = getSelectedListButton(ui.outputList);

  if (!fromButton || !toButton || fromButton.offsetParent === null || toButton.offsetParent === null) {
    ui.selectionEdge.removeAttribute("d");
    ui.selectionEdgeGlow.removeAttribute("d");
    ui.selectionEdge.style.opacity = "0";
    ui.selectionEdgeGlow.style.opacity = "0";
    return;
  }

  const start = getButtonNodeAnchor(fromButton, "from");
  const end = getButtonNodeAnchor(toButton, "to");
  if (!start || !end) {
    ui.selectionEdge.style.opacity = "0";
    ui.selectionEdgeGlow.style.opacity = "0";
    return;
  }

  const documentWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
    window.innerWidth
  );
  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight,
    window.innerHeight
  );
  ui.selectionGraph.setAttribute("viewBox", `0 0 ${documentWidth} ${documentHeight}`);
  ui.selectionGraph.style.width = `${documentWidth}px`;
  ui.selectionGraph.style.height = `${documentHeight}px`;

  const horizontalDistance = Math.max(120, Math.abs(end.x - start.x) * 0.42);
  const controlOffset = start.x <= end.x ? horizontalDistance : horizontalDistance * -1;
  const pathData = [
    `M ${start.x} ${start.y}`,
    `C ${start.x + controlOffset} ${start.y}, ${end.x - controlOffset} ${end.y}, ${end.x} ${end.y}`
  ].join(" ");

  ui.selectionEdge.setAttribute("d", pathData);
  ui.selectionEdgeGlow.setAttribute("d", pathData);
  ui.selectionEdge.style.opacity = "1";
  ui.selectionEdgeGlow.style.opacity = "1";
}

function scheduleSelectionGraphUpdate () {
  if (selectionGraphFrame !== null) return;
  selectionGraphFrame = window.requestAnimationFrame(updateSelectionGraph);
}

window.addEventListener("resize", scheduleSelectionGraphUpdate);
document.addEventListener("scroll", scheduleSelectionGraphUpdate, true);

/**
 * Filters a list of butttons to exclude those not matching a substring.
 * @param list Button list (div) to filter.
 * @param string Substring for which to search.
 */
const filterButtonList = (list: HTMLDivElement, string: string) => {
  for (const button of Array.from(list.children)) {
    if (!(button instanceof HTMLButtonElement)) continue;
    const formatIndex = button.getAttribute("format-index");
    let hasExtension = false;
    if (formatIndex) {
      const format = allOptions[parseInt(formatIndex)];
      hasExtension = format?.format.extension.toLowerCase().includes(string);
    }
    const hasText = button.textContent.toLowerCase().includes(string);
    if (!hasExtension && !hasText) {
      button.style.display = "none";
    } else {
      button.style.display = "";
    }
  }

  scheduleSelectionGraphUpdate();
}

/**
 * Handles search box input by filtering its parent container.
 * @param event Input event from an {@link HTMLInputElement}
 */
const searchHandler = (event: Event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  const formatContainer = target.closest(".format-container");
  if (!(formatContainer instanceof HTMLDivElement)) return;

  const targetParentList = formatContainer.querySelector(".format-list");
  if (!(targetParentList instanceof HTMLDivElement)) return;

  const string = target.value.toLowerCase();
  filterButtonList(targetParentList, string);
  syncSearchClearButtons();
};

function clearSearch (input: HTMLInputElement, list: HTMLDivElement) {
  input.value = "";
  filterButtonList(list, "");
  syncSearchClearButtons();
  input.focus();
}

function syncSearchClearButtons () {
  ui.inputSearchClear.disabled = ui.inputSearch.value.length === 0 || inputSearchLockedToSelectedFiles;
  ui.outputSearchClear.disabled = ui.outputSearch.value.length === 0;
}

function bindSearchClearButton (
  button: HTMLButtonElement,
  input: HTMLInputElement,
  list: HTMLDivElement
) {
  button.addEventListener("mousedown", event => {
    event.preventDefault();
    event.stopPropagation();
  });

  button.addEventListener("touchstart", event => {
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });

  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    clearSearch(input, list);
  });
}

// Assign search handler to both search boxes
ui.inputSearch.oninput = searchHandler;
ui.outputSearch.oninput = searchHandler;
bindSearchClearButton(ui.inputSearchClear, ui.inputSearch, ui.inputList);
bindSearchClearButton(ui.outputSearchClear, ui.outputSearch, ui.outputList);
syncSearchClearButtons();

// Map clicks in the file selection area to the file input element
ui.fileSelectArea.onclick = () => {
  ui.fileInput.click();
};

function getSelectedFileKey (file: File) {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function renderEmptyFileSelectionHero () {
  const dropZone = document.createElement("div");
  dropZone.id = "file-drop-zone";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Private, on-device conversion";
  dropZone.appendChild(eyebrow);

  const heading = document.createElement("h2");
  heading.textContent = "Click to add your file";
  dropZone.appendChild(heading);

  const hint = document.createElement("p");
  hint.id = "drop-hint-text";
  hint.textContent = "or drag and drop it here";
  dropZone.appendChild(hint);

  ui.fileSelectArea.replaceChildren(dropZone);
}

function removeSelectedFileByKey (fileKey: string) {
  selectedFiles = selectedFiles.filter(file => getSelectedFileKey(file) !== fileKey);

  if (selectedFiles.length === 0) {
    inputSearchLockedToSelectedFiles = false;
    ui.fileInput.value = "";
    renderEmptyFileSelectionHero();
  } else {
    renderSelectedFilesInHero(selectedFiles);
  }

  updateConvertButtonState();
  syncSearchClearButtons();
}

function clearSelectedFiles () {
  selectedFiles = [];
  inputSearchLockedToSelectedFiles = false;
  ui.fileInput.value = "";
  renderEmptyFileSelectionHero();
  updateConvertButtonState();
  syncSearchClearButtons();
}

function renderSelectedFilesInHero (files: File[]) {
  const dropZone = document.createElement("div");
  dropZone.id = "file-drop-zone";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = files.length === 1 ? "Selected file" : "Selected files";
  dropZone.appendChild(eyebrow);

  const heading = document.createElement("h2");
  heading.textContent = `${files.length} file${files.length === 1 ? "" : "s"} ready`;
  dropZone.appendChild(heading);

  const clearAllButton = document.createElement("button");
  clearAllButton.type = "button";
  clearAllButton.id = "selected-files-clear";
  clearAllButton.textContent = "Clear all";
  clearAllButton.addEventListener("click", event => {
    event.stopPropagation();
    clearSelectedFiles();
  });
  dropZone.appendChild(clearAllButton);

  const fileList = document.createElement("ul");
  fileList.id = "selected-file-list";

  for (const file of files) {
    const item = document.createElement("li");
    const fileKey = getSelectedFileKey(file);
    const name = document.createElement("span");
    name.className = "selected-file-name";
    name.textContent = file.name;
    item.appendChild(name);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "selected-file-remove";
    removeButton.textContent = "X";
    removeButton.setAttribute("aria-label", `Remove ${file.name}`);
    removeButton.addEventListener("click", event => {
      event.stopPropagation();
      removeSelectedFileByKey(fileKey);
    });
    item.appendChild(removeButton);

    fileList.appendChild(item);
  }

  dropZone.appendChild(fileList);

  const hint = document.createElement("p");
  hint.id = "drop-hint-text";
  hint.textContent = "click to choose different files or drag and drop more here";
  dropZone.appendChild(hint);

  ui.fileSelectArea.replaceChildren(dropZone);
}

/**
 * Validates and stores user selected files. Works for both manual
 * selection and file drag-and-drop.
 * @param event Either a file input element's "change" event,
 * or a "drop" event.
 */
const fileSelectHandler = (event: Event) => {

  let inputFiles;

  if (event instanceof DragEvent) {
    inputFiles = event.dataTransfer?.files;
    if (inputFiles) event.preventDefault();
  } else if (event instanceof ClipboardEvent) {
    inputFiles = event.clipboardData?.files;
  } else {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    inputFiles = target.files;
  }

  if (!inputFiles) return;
  const files = Array.from(inputFiles);
  if (files.length === 0) return;

  const candidateFiles = [...selectedFiles, ...files];

  if (candidateFiles.some(file => file.type !== candidateFiles[0].type)) {
    ui.fileInput.value = "";
    return alert("All input files must be of the same type.");
  }

  const dedupedFiles = new Map<string, File>();
  for (const file of candidateFiles) {
    dedupedFiles.set(getSelectedFileKey(file), file);
  }
  const mergedFiles = Array.from(dedupedFiles.values());
  if (mergedFiles.length === 0) return;

  mergedFiles.sort((a, b) => a.name === b.name ? 0 : (a.name < b.name ? -1 : 1));
  selectedFiles = mergedFiles;
  inputSearchLockedToSelectedFiles = mergedFiles.length > 0;
  ui.fileInput.value = "";

  renderSelectedFilesInHero(mergedFiles);

  // Common MIME type adjustments (to match "mime" library)
  let mimeType = normalizeMimeType(mergedFiles[0].type);

  const fileExtension = mergedFiles[0].name.split(".").pop()?.toLowerCase();

  // Find all buttons matching the input MIME type.
  const buttonsMatchingMime = Array.from(ui.inputList.children).filter(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    return button.getAttribute("mime-type") === mimeType;
  }) as HTMLButtonElement[];
  // If there are multiple, find one with a matching extension too
  let inputFormatButton: HTMLButtonElement;
  if (buttonsMatchingMime.length > 1) {
    inputFormatButton = buttonsMatchingMime.find(button => {
      const formatIndex = button.getAttribute("format-index");
      if (!formatIndex) return;
      const format = allOptions[parseInt(formatIndex)];
      return format.format.extension === fileExtension;
    }) || buttonsMatchingMime[0];
  } else {
    inputFormatButton = buttonsMatchingMime[0];
  }
  // Click button with matching MIME type.
  if (mimeType && inputFormatButton instanceof HTMLButtonElement) {
    inputFormatButton.click();
    ui.inputSearch.value = mimeType;
    filterButtonList(ui.inputList, ui.inputSearch.value);
    syncSearchClearButtons();
    return;
  }

  // Fall back to matching format by file extension if MIME type wasn't found.
  const buttonExtension = Array.from(ui.inputList.children).find(button => {
    if (!(button instanceof HTMLButtonElement)) return false;
    const formatIndex = button.getAttribute("format-index");
    if (!formatIndex) return;
    const format = allOptions[parseInt(formatIndex)];
    return format.format.extension.toLowerCase() === fileExtension;
  });
  if (buttonExtension instanceof HTMLButtonElement) {
    buttonExtension.click();
    ui.inputSearch.value = buttonExtension.getAttribute("mime-type") || "";
  } else {
    ui.inputSearch.value = fileExtension || "";
  }

  filterButtonList(ui.inputList, ui.inputSearch.value);
  syncSearchClearButtons();

};

// Add the file selection handler to both the file input element and to
// the window as a drag-and-drop event, and to the clipboard paste event.
ui.fileInput.addEventListener("change", fileSelectHandler);
window.addEventListener("drop", fileSelectHandler);
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("paste", fileSelectHandler);

ui.repoLinksButton.addEventListener("click", event => {
  event.stopPropagation();
  setMcpMenuOpen(false);
  setRepoMenuOpen(ui.repoLinksMenu.hidden);
});

ui.mcpCopyButton.addEventListener("click", event => {
  event.stopPropagation();
  setRepoMenuOpen(false);
  setMcpMenuOpen(ui.mcpMenu.hidden);
});

for (const button of Array.from(ui.mcpMenu.querySelectorAll("button[data-mcp-mode]"))) {
  if (!(button instanceof HTMLButtonElement)) continue;

  button.addEventListener("click", async event => {
    event.stopPropagation();

    const nextMode = button.dataset.mcpMode;
    if (nextMode !== "vite" && nextMode !== "docker") return;

    selectedMcpConfigMode = nextMode;
    saveSelectedMcpConfigMode();
    setMcpMenuOpen(false);
    updateMcpButtonUi();
    await copySelectedMcpConfig();
  });
}

document.addEventListener("click", event => {
  if (event.target instanceof Node && ui.repoLinksMenu.contains(event.target)) return;
  if (event.target === ui.repoLinksButton) return;
  if (event.target instanceof Node && ui.mcpMenu.contains(event.target)) return;
  if (event.target === ui.mcpCopyButton) return;
  setRepoMenuOpen(false);
  setMcpMenuOpen(false);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    setRepoMenuOpen(false);
    setMcpMenuOpen(false);
  }
});

/**
 * Display an on-screen popup.
 * @param html HTML content of the popup box.
 */
window.showPopup = function (html: string) {
  ui.popupBox.innerHTML = html;
  ui.popupBox.style.display = "block";
  ui.popupBackground.style.display = "block";
}
/**
 * Hide the on-screen popup.
 */
window.hidePopup = function () {
  ui.popupBox.style.display = "none";
  ui.popupBackground.style.display = "none";
}

const allOptions: Array<{ format: FileFormat, handler: FormatHandler }> = [];
const MAX_REMOTE_INPUT_CANDIDATES = 4;
const MAX_SUGGESTION_SCAN_MULTIPLIER = 3;

type GoalProfile = {
  keywords: string[];
  categories?: string[];
  extensions?: string[];
  preferLossless?: boolean;
  reason: string;
};

const GOAL_PROFILES: GoalProfile[] = [
  {
    keywords: ["editable", "edit", "source", "structured"],
    categories: ["text", "document"],
    extensions: ["txt", "md", "json", "svg", "html", "xml", "csv", "css"],
    reason: "matches editable output formats"
  },
  {
    keywords: ["text", "plain", "readable", "read"],
    categories: ["text", "document"],
    extensions: ["txt", "md", "json", "xml", "csv", "html"],
    reason: "matches text-oriented outputs"
  },
  {
    keywords: ["web", "browser", "website", "online", "embed"],
    categories: ["image", "text", "video", "audio"],
    extensions: ["webp", "png", "jpg", "jpeg", "svg", "html", "css", "mp4", "mp3"],
    reason: "matches web-friendly outputs"
  },
  {
    keywords: ["windows", "openable", "compatible", "share"],
    categories: ["image", "text", "document", "audio", "video"],
    extensions: ["png", "jpg", "jpeg", "bmp", "txt", "pdf", "wav", "mp3", "mp4"],
    reason: "matches broadly compatible outputs"
  },
  {
    keywords: ["extract", "unpack", "contents", "archive"],
    categories: ["text", "document"],
    extensions: ["zip", "txt", "json", "xml", "csv"],
    reason: "matches extraction-style outputs"
  },
  {
    keywords: ["lossless", "quality", "preserve"],
    preferLossless: true,
    reason: "prefers lossless outputs"
  }
];

function matchesRemoteSelection (
  option: { format: FileFormat, handler: FormatHandler },
  selection: {
    mime?: string;
    format?: string;
    extension?: string;
    internal?: string;
    handler?: string;
  },
  direction: "from" | "to"
) {
  if (direction === "from" && !option.format.from) return false;
  if (direction === "to" && !option.format.to) return false;

  if (selection.handler && option.handler.name !== selection.handler) return false;
  if (selection.mime && option.format.mime !== selection.mime) return false;
  if (selection.format && option.format.format !== selection.format) return false;
  if (selection.extension && option.format.extension !== selection.extension) return false;
  if (selection.internal && option.format.internal !== selection.internal) return false;
  return true;
}

function findRemoteOptions (
  selection: {
    mime?: string;
    format?: string;
    extension?: string;
    internal?: string;
    handler?: string;
  },
  direction: "from" | "to"
) {
  return allOptions.filter(option => matchesRemoteSelection(option, selection, direction));
}

function serializePath (path: ConvertPathNode[]) {
  return path.map(node => ({
    handler: node.handler.name,
    format: node.format
  }));
}

function summarizeSerializedPath (pathEntries: Array<{ handler: string, format: FileFormat }>) {
  return pathEntries.map(entry => `${entry.handler}:${entry.format.format}`).join(" -> ");
}

function serializeRemoteOption (option: { format: FileFormat, handler: FormatHandler }) {
  return {
    ...option.format,
    handler: option.handler.name
  };
}

function createRemoteSelectionFromOption (option: { format: FileFormat, handler: FormatHandler }) {
  return {
    mime: option.format.mime,
    format: option.format.format,
    extension: option.format.extension,
    internal: option.format.internal,
    handler: option.handler.name
  };
}

function getFormatCategories (format: FileFormat) {
  const category = format.category || format.mime.split("/")[0];
  return Array.isArray(category) ? category : [category];
}

function getOutputGroupingKey (option: { format: FileFormat, handler: FormatHandler }, simpleMode: boolean) {
  if (simpleMode) return `${option.format.mime}::${option.format.format}`;
  return `${option.format.mime}::${option.format.format}::${option.handler.name}`;
}

function detectInputOptionMatches (fileName: string, mimeType?: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  const normalizedMime = mimeType ? normalizeMimeType(mimeType) : undefined;

  return allOptions
    .filter(option => option.format.from)
    .map(option => {
      let score = 0;

      if (normalizedMime && option.format.mime === normalizedMime) score += 5;
      if (extension && option.format.extension.toLowerCase() === extension) score += 4;
      if (normalizedMime && option.format.mime.split("/")[0] === normalizedMime.split("/")[0]) score += 1;

      return {
        option,
        score
      };
    })
    .filter(option => option.score > 0)
    .sort((left, right) => right.score - left.score || left.option.format.name.localeCompare(right.option.format.name));
}

function detectInputFormats (fileName: string, mimeType?: string) {
  return detectInputOptionMatches(fileName, mimeType)
    .map(({ option, score }) => ({
      ...option.format,
      handler: option.handler.name,
      score
    }));
}

function resolveRemoteInputCandidates (
  from: {
    mime?: string;
    format?: string;
    extension?: string;
    internal?: string;
    handler?: string;
  } | undefined,
  fileName?: string,
  mimeType?: string
) {
  if (from && Object.values(from).some(Boolean)) {
    return findRemoteOptions(from, "from")
      .slice(0, MAX_REMOTE_INPUT_CANDIDATES)
      .map(option => ({
        option,
        score: 1000,
        reason: "matched explicit input selection"
      }));
  }

  if (!fileName) return [];

  return detectInputOptionMatches(fileName, mimeType)
    .slice(0, MAX_REMOTE_INPUT_CANDIDATES)
    .map(match => ({
      ...match,
      reason: `detected from ${fileName}`
    }));
}

async function collectPathCandidates (
  from: { format: FileFormat, handler: FormatHandler },
  to: { format: FileFormat, handler: FormatHandler },
  simpleMode: boolean,
  limit = 1
) {
  const results: ConvertPathNode[][] = [];
  const iterator = window.traversionGraph.searchPath(from, to, simpleMode);

  for await (const path of iterator) {
    results.push(path);
    if (results.length >= limit) break;
  }

  return results;
}

function buildPathPreview (path: ConvertPathNode[]) {
  const serializedPath = serializePath(path);
  const handlers = Array.from(new Set(serializedPath.map(entry => entry.handler)));
  const input = serializedPath[0];
  const output = serializedPath.at(-1);
  const conversionCount = Math.max(0, serializedPath.length - 1);

  return {
    path: serializedPath,
    pathSummary: summarizeSerializedPath(serializedPath),
    conversionCount,
    handlers,
    handlerCount: handlers.length,
    multipleTools: handlers.length > 1,
    direct: conversionCount <= 1,
    lossy: serializedPath.slice(1).some(entry => !entry.format.lossless),
    intermediateFormats: serializedPath.slice(1, -1).map(entry => entry.format.format),
    categories: Array.from(new Set(serializedPath.map(entry => getFormatCategories(entry.format)).flat())),
    input: input
      ? {
          ...input.format,
          handler: input.handler
        }
      : undefined,
    output: output
      ? {
          ...output.format,
          handler: output.handler
        }
      : undefined
  };
}

function getRouteRankScore (
  preview: ReturnType<typeof buildPathPreview>,
  inputScore: number
) {
  return inputScore
    + (preview.direct ? 6 : 0)
    + Math.max(0, 5 - preview.conversionCount)
    + (preview.lossy ? 0 : 1)
    - (preview.handlerCount - 1) * 0.25;
}

function compareRankedRoutes (
  left: { rankScore: number, preview: ReturnType<typeof buildPathPreview> },
  right: { rankScore: number, preview: ReturnType<typeof buildPathPreview> }
) {
  return right.rankScore - left.rankScore
    || left.preview.conversionCount - right.preview.conversionCount
    || Number(left.preview.lossy) - Number(right.preview.lossy)
    || left.preview.pathSummary.localeCompare(right.preview.pathSummary);
}

async function resolveBestRoute ({
  from,
  to,
  fileName,
  mimeType,
  simpleMode = true
}: {
  from?: {
    mime?: string;
    format?: string;
    extension?: string;
    internal?: string;
    handler?: string;
  };
  to: {
    mime?: string;
    format?: string;
    extension?: string;
    internal?: string;
    handler?: string;
  };
  fileName?: string;
  mimeType?: string;
  simpleMode?: boolean;
}) {
  const inputCandidates = resolveRemoteInputCandidates(from, fileName, mimeType);
  if (inputCandidates.length === 0) {
    return { ok: false, error: "Input format selection did not match any supported format." };
  }

  const outputOptions = findRemoteOptions(to, "to");
  if (outputOptions.length === 0) {
    return { ok: false, error: "Output format selection did not match any supported format." };
  }

  let bestMatch:
    | {
        input: typeof inputCandidates[number];
        outputOption: { format: FileFormat, handler: FormatHandler };
        preview: ReturnType<typeof buildPathPreview>;
        rankScore: number;
      }
    | undefined;

  for (const inputCandidate of inputCandidates) {
    for (const outputOption of outputOptions) {
      const firstPath = (await collectPathCandidates(inputCandidate.option, outputOption, simpleMode, 1))[0];
      if (!firstPath) continue;

      const preview = buildPathPreview(firstPath);
      const current = {
        input: inputCandidate,
        outputOption,
        preview,
        rankScore: getRouteRankScore(preview, inputCandidate.score)
      };

      if (!bestMatch || compareRankedRoutes(current, bestMatch) < 0) {
        bestMatch = current;
      }
    }
  }

  if (!bestMatch) {
    return { ok: false, error: "No conversion path found." };
  }

  return {
    ok: true,
    input: serializeRemoteOption(bestMatch.input.option),
    inputSelection: createRemoteSelectionFromOption(bestMatch.input.option),
    inputReason: bestMatch.input.reason,
    output: serializeRemoteOption(bestMatch.outputOption),
    outputSelection: createRemoteSelectionFromOption(bestMatch.outputOption),
    rankScore: bestMatch.rankScore,
    preview: bestMatch.preview,
    path: bestMatch.preview.path
  };
}

async function listReachableOutputOptions ({
  from,
  fileName,
  mimeType,
  simpleMode = true,
  limit = 25
}: {
  from?: {
    mime?: string;
    format?: string;
    extension?: string;
    internal?: string;
    handler?: string;
  };
  fileName?: string;
  mimeType?: string;
  simpleMode?: boolean;
  limit?: number;
}) {
  const inputCandidates = resolveRemoteInputCandidates(from, fileName, mimeType);
  if (inputCandidates.length === 0) {
    return { ok: false, error: "Input format selection did not match any supported format." };
  }

  const rankedOutputs = new Map<string, {
    input: typeof inputCandidates[number];
    outputOption: { format: FileFormat, handler: FormatHandler };
    preview: ReturnType<typeof buildPathPreview>;
    rankScore: number;
  }>();

  for (const inputCandidate of inputCandidates) {
    for (const outputOption of allOptions.filter(option => option.format.to)) {
      const firstPath = (await collectPathCandidates(inputCandidate.option, outputOption, simpleMode, 1))[0];
      if (!firstPath) continue;

      const preview = buildPathPreview(firstPath);
      const current = {
        input: inputCandidate,
        outputOption,
        preview,
        rankScore: getRouteRankScore(preview, inputCandidate.score)
      };
      const key = getOutputGroupingKey(outputOption, simpleMode);
      const previous = rankedOutputs.get(key);

      if (!previous || compareRankedRoutes(current, previous) < 0) {
        rankedOutputs.set(key, current);
      }
    }
  }

  return {
    ok: true,
    outputs: Array.from(rankedOutputs.values())
      .sort(compareRankedRoutes)
      .slice(0, limit)
      .map(result => ({
        output: serializeRemoteOption(result.outputOption),
        outputSelection: createRemoteSelectionFromOption(result.outputOption),
        input: serializeRemoteOption(result.input.option),
        inputSelection: createRemoteSelectionFromOption(result.input.option),
        inputReason: result.input.reason,
        rankScore: result.rankScore,
        preview: result.preview
      }))
  };
}

function scoreGoalAgainstCandidate (
  goal: string,
  candidate: {
    output: FileFormat & { handler: string };
    preview: ReturnType<typeof buildPathPreview>;
  }
) {
  const normalizedGoal = goal.trim().toLowerCase();
  const tokens = normalizedGoal.split(/[^a-z0-9.+-]+/).filter(Boolean);
  const categories = getFormatCategories(candidate.output);
  const searchFields = [
    candidate.output.name,
    candidate.output.format,
    candidate.output.extension,
    candidate.output.mime,
    candidate.output.internal,
    candidate.output.handler,
    ...categories
  ].join(" ").toLowerCase();

  let score = 0;
  const reasons: string[] = [];

  if (searchFields.includes(normalizedGoal)) {
    score += 12;
    reasons.push(`directly matches \"${normalizedGoal}\"`);
  }

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (searchFields.includes(token)) {
      score += 2;
      reasons.push(`matches \"${token}\"`);
    }
  }

  for (const profile of GOAL_PROFILES) {
    if (!profile.keywords.some(keyword => normalizedGoal.includes(keyword))) continue;

    if (profile.categories?.some(category => categories.includes(category))) {
      score += 4;
      reasons.push(profile.reason);
    }
    if (profile.extensions?.includes(candidate.output.extension.toLowerCase())) {
      score += 5;
      reasons.push(profile.reason);
    }
    if (profile.preferLossless && !candidate.preview.lossy) {
      score += 4;
      reasons.push(profile.reason);
    }
  }

  if (candidate.preview.direct) score += 1;
  if (!candidate.preview.lossy) score += 1;

  return {
    score,
    reasons: Array.from(new Set(reasons))
  };
}

function buildConversionExplanation (route: {
  input: FileFormat & { handler: string };
  output: FileFormat & { handler: string };
  preview: ReturnType<typeof buildPathPreview>;
}) {
  return [
    `Converts ${route.input.format} to ${route.output.format} in ${route.preview.conversionCount} ${route.preview.conversionCount === 1 ? "step" : "steps"}.`,
    route.preview.multipleTools
      ? `Uses ${route.preview.handlers.join(", ")} across multiple backends.`
      : `Uses ${route.preview.handlers[0]} as the conversion backend.`,
    route.preview.lossy
      ? "This route may be lossy or drop some fidelity."
      : "This route stays on lossless outputs where handlers report that capability.",
    route.preview.intermediateFormats.length > 0
      ? `Intermediate formats: ${route.preview.intermediateFormats.join(" -> ")}.`
      : "No intermediate formats are required."
  ].join(" ");
}

window.convertApi = {
  ready: false,
  listHandlers () {
    return handlers.map(handler => ({
      name: handler.name,
      ready: handler.ready,
      supportAnyInput: handler.supportAnyInput === true,
      priority: handler.priority ?? 0,
      formatCount: window.supportedFormatCache.get(handler.name)?.length ?? handler.supportedFormats?.length ?? 0
    }));
  },
  listStaleHandlers () {
    return getHandlersNeedingCacheRefresh().map(handler => ({
      name: handler.name,
      version: getHandlerCacheVersion(handler),
      cached: window.supportedFormatCache.has(handler.name)
    }));
  },
  async warmHandlers ({ handlerNames } = {}) {
    return await refreshHandlerCacheEntries(handlerNames);
  },
  getSupportedFormatCachePayload () {
    return JSON.parse(serializeSupportedFormatCache(false)) as SupportedFormatCachePayload;
  },
  listFormats () {
    return allOptions.map(option => ({ ...option.format, handler: option.handler.name }));
  },
  detectInputFormats ({ fileName, mimeType }) {
    return detectInputFormats(fileName, mimeType);
  },
  async listOutputOptions ({ from, fileName, mimeType, simpleMode: useSimpleMode = true, limit = 25 }) {
    return await listReachableOutputOptions({
      from,
      fileName,
      mimeType,
      simpleMode: useSimpleMode,
      limit
    });
  },
  async planConversion ({ from, to, simpleMode: useSimpleMode = true }) {
    const inputOption = findRemoteOptions(from, "from")[0];
    if (!inputOption) {
      return { ok: false, error: "Input format selection did not match any supported format." };
    }

    const outputOption = findRemoteOptions(to, "to")[0];
    if (!outputOption) {
      return { ok: false, error: "Output format selection did not match any supported format." };
    }

    const iterator = window.traversionGraph.searchPath(inputOption, outputOption, useSimpleMode);
    const firstResult = await iterator.next();
    if (firstResult.done || !firstResult.value) {
      return { ok: false, error: "No conversion path found." };
    }

    return { ok: true, path: serializePath(firstResult.value) };
  },
  async previewConversionResult ({ from, to, fileName, mimeType, simpleMode: useSimpleMode = true }) {
    return await resolveBestRoute({
      from,
      to,
      fileName,
      mimeType,
      simpleMode: useSimpleMode
    });
  },
  async explainConversion ({ from, to, fileName, mimeType, simpleMode: useSimpleMode = true }) {
    const route = await resolveBestRoute({
      from,
      to,
      fileName,
      mimeType,
      simpleMode: useSimpleMode
    });
    if (!route.ok || !route.preview || !route.input || !route.output) return route;

    return {
      ...route,
      explanation: buildConversionExplanation({
        input: route.input,
        output: route.output,
        preview: route.preview
      })
    };
  },
  async suggestConversion ({ from, fileName, mimeType, goal, simpleMode: useSimpleMode = true, limit = 5 }) {
    const reachableOutputs = await listReachableOutputOptions({
      from,
      fileName,
      mimeType,
      simpleMode: useSimpleMode,
      limit: Math.max(limit * MAX_SUGGESTION_SCAN_MULTIPLIER, limit)
    });
    if (!reachableOutputs.ok) return reachableOutputs;

    return {
      ok: true,
      goal,
      suggestions: (reachableOutputs.outputs ?? [])
        .map(candidate => {
          const goalScore = scoreGoalAgainstCandidate(goal, {
            output: candidate.output,
            preview: candidate.preview
          });

          return {
            ...candidate,
            suggestionScore: candidate.rankScore + goalScore.score,
            why: goalScore.reasons.length > 0
              ? goalScore.reasons.join("; ")
              : `reachable via ${candidate.preview.pathSummary}`
          };
        })
        .sort((left, right) => right.suggestionScore - left.suggestionScore || compareRankedRoutes(left, right))
        .slice(0, limit)
    };
  },
  async convert ({ files, from, to, simpleMode: useSimpleMode = true }) {
    const inputOption = findRemoteOptions(from, "from")[0];
    if (!inputOption) {
      return { ok: false, error: "Input format selection did not match any supported format." };
    }

    const outputOption = findRemoteOptions(to, "to")[0];
    if (!outputOption) {
      return { ok: false, error: "Output format selection did not match any supported format." };
    }

    const inputFileData = files.map(file => ({
      name: file.name,
      bytes: new Uint8Array(file.bytes)
    }));

    const output = await window.tryConvertByTraversing(inputFileData, inputOption, outputOption);
    if (!output) {
      return { ok: false, error: "Failed to find a working conversion route." };
    }

    return {
      ok: true,
      outputs: output.files.map(file => ({
        name: file.name,
        bytes: Array.from(file.bytes)
      })),
      path: serializePath(output.path)
    };
  }
};

function updateConvertButtonState () {
  const allSelected = document.getElementsByClassName("selected");
  ui.convertButton.className = allSelected.length === 2 && selectedFiles.length > 0 ? "" : "disabled";
  scheduleSelectionGraphUpdate();
}

function updateModeUi () {
  if (simpleMode) {
    ui.modeToggleButton.textContent = "Simple mode";
    ui.modeDescription.textContent = "Simple mode groups formats together. Switch to advanced mode when you want to pick a specific backend or compare multiple tools that support the same format.";
    document.body.style.setProperty("--highlight-color", "#1c77ff");
    document.body.style.setProperty("--highlight-hover", "#155fcb");
    document.body.style.setProperty("--highlight-light", "#93c5fd");
    document.body.style.setProperty("--highlight-soft", "rgba(28, 119, 255, 0.14)");
    document.body.style.setProperty("--bg-gradient-start", "#f8fbff");
    document.body.style.setProperty("--bg-gradient-end", "#dbeafe");
    document.body.style.setProperty("--bg-orb-left", "rgba(147, 197, 253, 0.36)");
    document.body.style.setProperty("--bg-orb-right", "rgba(59, 130, 246, 0.24)");
    document.body.style.setProperty("--hero-gradient-start", "rgba(28, 119, 255, 0.94)");
    document.body.style.setProperty("--hero-gradient-end", "rgba(17, 94, 203, 0.9)");
    return;
  }

  ui.modeToggleButton.textContent = "Advanced mode";
  ui.modeDescription.textContent = "Advanced mode shows handler-specific routes and tools, so you can choose the exact converter instead of the simplified format-only view.";
  document.body.style.setProperty("--highlight-color", "#ff6f1c");
  document.body.style.setProperty("--highlight-hover", "#d4570f");
  document.body.style.setProperty("--highlight-light", "#fdba74");
  document.body.style.setProperty("--highlight-soft", "rgba(255, 111, 28, 0.18)");
  document.body.style.setProperty("--bg-gradient-start", "#fff7ed");
  document.body.style.setProperty("--bg-gradient-end", "#fed7aa");
  document.body.style.setProperty("--bg-orb-left", "rgba(253, 186, 116, 0.34)");
  document.body.style.setProperty("--bg-orb-right", "rgba(251, 146, 60, 0.22)");
  document.body.style.setProperty("--hero-gradient-start", "rgba(255, 111, 28, 0.94)");
  document.body.style.setProperty("--hero-gradient-end", "rgba(212, 87, 15, 0.9)");
}

window.supportedFormatCache = new Map();
window.supportedFormatCacheVersions = new Map();
window.traversionGraph = new TraversionGraph();

window.printSupportedFormatCache = () => {
  return serializeSupportedFormatCache();
}


async function buildOptionList () {

  const selectedInputSnapshot = getOptionSelectionSnapshot(getSelectedListButton(ui.inputList));
  const selectedOutputSnapshot = getOptionSelectionSnapshot(getSelectedListButton(ui.outputList));

  allOptions.length = 0;
  ui.inputList.innerHTML = "";
  ui.outputList.innerHTML = "";

  const inputFragment = document.createDocumentFragment();
  const outputFragment = document.createDocumentFragment();
  const seenInputFormats = new Set<string>();
  const seenOutputFormats = new Set<string>();

  const clickHandler = (event: Event) => {
    if (!(event.currentTarget instanceof HTMLButtonElement)) return;
    const button = event.currentTarget;
    const targetParent = button.parentElement;
    const previous = targetParent?.getElementsByClassName("selected")?.[0];
    const isSameButton = previous === button;

    if (previous instanceof HTMLButtonElement) previous.classList.remove("selected");
    if (!isSameButton) {
      button.classList.add("selected");
      const option = allOptions[Number(button.getAttribute("format-index"))];
      const listSide = button.dataset.listSide === "to" ? "to" : "from";
      if (option) preloadHandlerForSide(listSide, option.handler);
    }

    updateConvertButtonState();
  };

  for (const handler of handlers) {
    const supportedFormats = window.supportedFormatCache.get(handler.name);
    if (!supportedFormats) {
      console.warn(`Handler "${handler.name}" doesn't support any formats.`);
      continue;
    }
    for (const format of supportedFormats) {

      if (!format.mime) continue;

      allOptions.push({ format, handler });
      const optionIndex = allOptions.length - 1;

      // In simple mode, display each input/output format only once
      let addToInputs = true, addToOutputs = true;
      if (simpleMode) {
        const dedupeKey = `${format.mime}::${format.format}`;
        addToInputs = !seenInputFormats.has(dedupeKey);
        addToOutputs = !seenOutputFormats.has(dedupeKey);
        if ((!format.from || !addToInputs) && (!format.to || !addToOutputs)) continue;
        if (format.from && addToInputs) seenInputFormats.add(dedupeKey);
        if (format.to && addToOutputs) seenOutputFormats.add(dedupeKey);
      }

      if (format.from && addToInputs) {
        inputFragment.appendChild(createOptionButton(optionIndex, format, handler, "from", clickHandler));
      }
      if (format.to && addToOutputs) {
        outputFragment.appendChild(createOptionButton(optionIndex, format, handler, "to", clickHandler));
      }

    }
  }

  ui.inputList.appendChild(inputFragment);
  ui.outputList.appendChild(outputFragment);
  restoreSelectionSnapshot(ui.inputList, selectedInputSnapshot, "from");
  restoreSelectionSnapshot(ui.outputList, selectedOutputSnapshot, "to");
  window.traversionGraph.init(window.supportedFormatCache, handlers);
  saveSupportedFormatCache();
  filterButtonList(ui.inputList, ui.inputSearch.value);
  filterButtonList(ui.outputList, ui.outputSearch.value);
  updateConvertButtonState();

  if (pendingStartupPopupHtml) {
    window.showPopup(pendingStartupPopupHtml);
    pendingStartupPopupHtml = null;
  } else {
    window.hidePopup();
  }

  scheduleSelectionGraphUpdate();

}

(async () => {
  await loadSupportedFormatCacheReport();

  try {
    const response = await fetch("cache.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load cache.json (${response.status}).`);

    const cacheJSON = await response.json();
    if (!loadSupportedFormatCache(cacheJSON, "dist/cache.json")) {
      throw new Error("Unsupported cache.json format.");
    }
  } catch {
    try {
      const localCache = localStorage.getItem(SUPPORTED_FORMAT_CACHE_STORAGE_KEY);
      if (localCache) {
        if (!loadSupportedFormatCache(JSON.parse(localCache), "localStorage")) {
          throw new Error("Unsupported localStorage cache format.");
        }
      } else {
        console.warn(
          "Missing supported format precache.\n\n" +
          "Run npm run cache:build or restart Vite to regenerate dist/cache.json."
        );
      }
    } catch {
      console.warn(
        "Missing supported format precache.\n\n" +
        "Run npm run cache:build or restart Vite to regenerate dist/cache.json."
      );
    }
  } finally {
    if (IS_MANUAL_CACHE_WARM_MODE) {
      window.convertApi.ready = true;
      console.log("Cache warmup API ready.");
      return;
    }

    if (window.supportedFormatCache.size === 0) {
      await refreshHandlerCacheEntries();
    } else {
      const missingHandlers = getHandlersMissingCacheEntries();
      if (missingHandlers.length > 0) {
        await refreshHandlerCacheEntries(missingHandlers.map(handler => handler.name));
      }
    }

    await buildOptionList();
    window.convertApi.ready = true;
    console.log("Built initial format list.");
  }
})();

ui.modeToggleButton.addEventListener("click", () => {
  simpleMode = !simpleMode;
  updateModeUi();
  buildOptionList();
});

let deadEndAttempts: ConvertPathNode[][];

async function attemptConvertPath (files: FileData[], path: ConvertPathNode[]) {

  const pathString = path.map(c => c.format.format).join(" → ");

  // Exit early if we've encountered a known dead end
  for (const deadEnd of deadEndAttempts) {
    let isDeadEnd = true;
    for (let i = 0; i < deadEnd.length; i++) {
      if (path[i] === deadEnd[i]) continue;
      isDeadEnd = false;
      break;
    }
    if (isDeadEnd) {
      const deadEndString = deadEnd.slice(-2).map(c => c.format.format).join(" → ");
      console.warn(`Skipping ${pathString} due to dead end near ${deadEndString}.`);
      return null;
    }
  }

  ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
    <p>Trying <b>${pathString}</b>...</p>`;

  for (let i = 0; i < path.length - 1; i ++) {
    const handler = path[i + 1].handler;
    try {
      let supportedFormats = window.supportedFormatCache.get(handler.name);
      if (!handler.ready) {
        await handler.init();
        if (!handler.ready) throw `Handler "${handler.name}" not ready after init.`;
        if (handler.supportedFormats) {
          setSupportedFormatCacheEntry(handler, handler.supportedFormats);
          supportedFormats = handler.supportedFormats;
        }
      }
      if (!supportedFormats) throw `Handler "${handler.name}" doesn't support any formats.`;
      const inputFormat = supportedFormats.find(c =>
        c.from
        && c.mime === path[i].format.mime
        && c.format === path[i].format.format
      ) || (handler.supportAnyInput ? path[i].format : undefined);
      if (!inputFormat) throw `Handler "${handler.name}" doesn't support the "${path[i].format.format}" format.`;
      files = (await Promise.all([
        handler.doConvert(files, inputFormat, path[i + 1].format),
        // Ensure that we wait long enough for the UI to update
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      ]))[0];
      if (files.some(c => !c.bytes.length)) throw "Output is empty.";
    } catch (e) {

      console.log(path.map(c => c.format.format));
      console.error(handler.name, `${path[i].format.format} → ${path[i + 1].format.format}`, e);

      // Dead ends are added both to the graph and to the attempt system.
      // The graph may still have old paths queued from before they were
      // marked as dead ends, so we catch that here.
      const deadEndPath = path.slice(0, i + 2);
      deadEndAttempts.push(deadEndPath);
      window.traversionGraph.addDeadEndPath(path.slice(0, i + 2));

      ui.popupBox.innerHTML = `<h2>Finding conversion route...</h2>
        <p>Looking for a valid path...</p>`;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return null;

    }
  }

  return { files, path };

}

window.tryConvertByTraversing = async function (
  files: FileData[],
  from: ConvertPathNode,
  to: ConvertPathNode
) {
  deadEndAttempts = [];
  window.traversionGraph.clearDeadEndPaths();
  for await (const path of window.traversionGraph.searchPath(from, to, simpleMode)) {
    // Use exact output format if the target handler supports it
    if (path.at(-1)?.handler === to.handler) {
      path[path.length - 1] = to;
    }
    const attempt = await attemptConvertPath(files, path);
    if (attempt) return attempt;
  }
  return null;
}

function downloadFile (bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
}

ui.convertButton.onclick = async function () {

  const inputFiles = selectedFiles;

  if (inputFiles.length === 0) {
    return alert("Select an input file.");
  }

  const inputButton = document.querySelector("#from-list .selected");
  if (!inputButton) return alert("Specify input file format.");

  const outputButton = document.querySelector("#to-list .selected");
  if (!outputButton) return alert("Specify output file format.");

  const inputOption = allOptions[Number(inputButton.getAttribute("format-index"))];
  const outputOption = allOptions[Number(outputButton.getAttribute("format-index"))];

  const inputFormat = inputOption.format;
  const outputFormat = outputOption.format;

  try {

    const inputFileData = [];
    for (const inputFile of inputFiles) {
      const inputBuffer = await inputFile.arrayBuffer();
      const inputBytes = new Uint8Array(inputBuffer);
      if (
        inputFormat.mime === outputFormat.mime
        && inputFormat.format === outputFormat.format
      ) {
        downloadFile(inputBytes, inputFile.name);
        continue;
      }
      inputFileData.push({ name: inputFile.name, bytes: inputBytes });
    }

    window.showPopup("<h2>Finding conversion route...</h2>");
    // Delay for a bit to give the browser time to render
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const output = await window.tryConvertByTraversing(inputFileData, inputOption, outputOption);
    if (!output) {
      window.hidePopup();
      alert("Failed to find conversion route.");
      return;
    }

    for (const file of output.files) {
      downloadFile(file.bytes, file.name);
    }

    window.showPopup(
      `<h2>Converted ${inputOption.format.format} to ${outputOption.format.format}!</h2>` +
      `<p>Path used: <b>${output.path.map(c => c.format.format).join(" → ")}</b>.</p>\n` +
      `<button onclick="window.hidePopup()">OK</button>`
    );

  } catch (e) {

    window.hidePopup();
    alert("Unexpected error while routing:\n" + e);
    console.error(e);

  }

};

updateModeUi();
loadSelectedMcpConfigMode();
