import type { FormatHandler } from "../FormatHandler.ts";

declare const __HANDLER_SOURCE_HASHES__: Record<string, string>;
declare const __HANDLER_MANIFEST__: Array<{
	path: string;
	exportName: string;
	name: string;
	supportAnyInput?: boolean;
	priority?: number;
}>;

type HandlerConstructor = new () => FormatHandler;
type HandlerModule = Record<string, unknown>;

type HandlerManifestEntry = {
	path: string;
	exportName: string;
	name: string;
	supportAnyInput?: boolean;
	priority?: number;
};

type LazyFormatHandler = FormatHandler & {
	preload?: () => Promise<void>;
};

function isFormatHandler (value: unknown): value is FormatHandler {
	if (!value || typeof value !== "object") return false;

	const candidate = value as Partial<FormatHandler>;
	return typeof candidate.name === "string"
		&& typeof candidate.init === "function"
		&& typeof candidate.doConvert === "function"
		&& typeof candidate.ready === "boolean";
}

function instantiateHandler (candidate: unknown): FormatHandler | null {
	if (isFormatHandler(candidate)) return candidate;
	if (typeof candidate !== "function") return null;

	try {
		const instance = new (candidate as HandlerConstructor)();
		return isFormatHandler(instance) ? instance : null;
	} catch {
		return null;
	}
}


class DeferredHandler implements LazyFormatHandler {
	public name: string;
	public cacheVersion?: string;
	public priority?: number;
	public supportedFormats?: FormatHandler["supportedFormats"];
	public supportAnyInput?: boolean;
	public ready = false;

	#entry: HandlerManifestEntry;
	#loader: () => Promise<HandlerModule>;
	#instance: FormatHandler | null = null;
	#loadPromise: Promise<FormatHandler> | null = null;

	constructor (entry: HandlerManifestEntry, loader: () => Promise<HandlerModule>) {
		this.#entry = entry;
		this.#loader = loader;
		this.name = entry.name;
		this.priority = entry.priority ?? 0;
		this.supportAnyInput = entry.supportAnyInput === true;
		this.cacheVersion = `${__HANDLER_SOURCE_HASHES__[entry.path] ?? entry.path}:${entry.exportName}`;
	}

	async #getInstance () {
		if (this.#instance) return this.#instance;
		if (this.#loadPromise) return this.#loadPromise;

		this.#loadPromise = (async () => {
			const moduleExports = await this.#loader();
			const candidate = this.#entry.exportName === "default"
				? moduleExports.default
				: moduleExports[this.#entry.exportName];
			const instance = instantiateHandler(candidate);
			if (!instance) {
				throw new Error(`Failed to lazy-load handler \"${this.name}\" from ${this.#entry.path} (${this.#entry.exportName}).`);
			}

			instance.cacheVersion = this.cacheVersion;
			if (this.supportedFormats && !instance.supportedFormats) {
				instance.supportedFormats = this.supportedFormats;
			}
			if (this.supportAnyInput === true) {
				instance.supportAnyInput = true;
			}
			if ((this.priority ?? 0) !== 0 && instance.priority === undefined) {
				instance.priority = this.priority;
			}

			this.#instance = instance;
			this.ready = instance.ready;
			return instance;
		})();

		try {
			return await this.#loadPromise;
		} finally {
			this.#loadPromise = null;
		}
	}

	async preload () {
		await this.#getInstance();
	}

	async init () {
		const instance = await this.#getInstance();
		await instance.init();
		this.ready = instance.ready;
		if (instance.supportedFormats) this.supportedFormats = instance.supportedFormats;
		this.supportAnyInput = instance.supportAnyInput === true;
		this.priority = instance.priority ?? this.priority;
	}

	async doConvert (...args: Parameters<FormatHandler["doConvert"]>) {
		const instance = await this.#getInstance();
		if (!instance.ready) {
			await this.init();
		}
		return await instance.doConvert(...args);
	}
}

function discoverHandlers (): FormatHandler[] {
	const moduleLoaders = import.meta.glob("./*.{ts,js}") as Record<string, () => Promise<HandlerModule>>;
	const manifest = [...__HANDLER_MANIFEST__];
	const seenNames = new Set<string>();
	const discovered: Array<{ path: string; exportName: string; handler: FormatHandler }> = [];

	for (const entry of manifest) {
		if (seenNames.has(entry.name)) {
			console.warn(`Skipping duplicate handler registration for "${entry.name}" from ${entry.path} (${entry.exportName}).`);
			continue;
		}

		const loader = moduleLoaders[entry.path];
		if (!loader) {
			console.warn(`Missing lazy loader for handler "${entry.name}" at ${entry.path}.`);
			continue;
		}

		seenNames.add(entry.name);
		const handler = new DeferredHandler(entry, loader);
		discovered.push({ path: entry.path, exportName: entry.exportName, handler });
	}

	discovered.sort((left, right) => {
		const priorityDelta = (right.handler.priority ?? 0) - (left.handler.priority ?? 0);
		if (priorityDelta !== 0) return priorityDelta;

		const pathDelta = left.path.localeCompare(right.path);
		if (pathDelta !== 0) return pathDelta;

		return left.exportName.localeCompare(right.exportName);
	});

	return discovered.map(entry => entry.handler);
}

const handlers = discoverHandlers();

export default handlers;
