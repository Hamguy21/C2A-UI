import type { FileFormat, FileData, ConvertPathNode } from "./FormatHandler.js";
import type { TraversionGraph } from "./TraversionGraph.js";

interface RemoteFormatSelection {
  mime?: string;
  format?: string;
  extension?: string;
  internal?: string;
  handler?: string;
}

interface RemoteFileInput {
  name: string;
  bytes: number[];
}

interface RemoteApiResult {
  ok: boolean;
  error?: string;
}

interface RemotePlanResult extends RemoteApiResult {
  path?: Array<{
    handler: string;
    format: FileFormat;
  }>;
}

interface RemoteRoutePreview {
  path: Array<{
    handler: string;
    format: FileFormat;
  }>;
  pathSummary: string;
  conversionCount: number;
  handlers: string[];
  handlerCount: number;
  multipleTools: boolean;
  direct: boolean;
  lossy: boolean;
  intermediateFormats: string[];
  categories: string[];
  input?: FileFormat & { handler: string };
  output?: FileFormat & { handler: string };
}

interface RemoteRoutePreviewResult extends RemotePlanResult {
  input?: FileFormat & { handler: string };
  inputSelection?: RemoteFormatSelection;
  inputReason?: string;
  output?: FileFormat & { handler: string };
  outputSelection?: RemoteFormatSelection;
  rankScore?: number;
  preview?: RemoteRoutePreview;
  explanation?: string;
}

interface RemoteConvertResult extends RemoteApiResult {
  outputs?: Array<{
    name: string;
    bytes: number[];
  }>;
  path?: Array<{
    handler: string;
    format: FileFormat;
  }>;
}

interface ConvertRemoteApi {
  ready: boolean;
  listHandlers: () => Array<{
    name: string;
    ready: boolean;
    supportAnyInput: boolean;
    priority: number;
    formatCount: number;
  }>;
  listStaleHandlers: () => Array<{
    name: string;
    version: string;
    cached: boolean;
  }>;
  warmHandlers: (args?: {
    handlerNames?: string[];
  }) => Promise<{
    updated: Array<{
      name: string;
      version: string;
      formats: FileFormat[];
    }>;
    failed: Array<{
      name: string;
      version: string;
      error: string;
    }>;
  }>;
  getSupportedFormatCachePayload: () => {
    schemaVersion: number;
    handlers: Array<{
      name: string;
      version?: string | null;
      formats: FileFormat[];
    }>;
  };
  listFormats: () => Array<FileFormat & { handler: string }>;
  detectInputFormats: (args: {
    fileName: string;
    mimeType?: string;
  }) => Array<(FileFormat & { handler: string; score: number })>;
  listOutputOptions: (args: {
    from?: RemoteFormatSelection;
    fileName?: string;
    mimeType?: string;
    simpleMode?: boolean;
    limit?: number;
  }) => Promise<RemoteApiResult & {
    outputs?: Array<{
      output: FileFormat & { handler: string };
      outputSelection: RemoteFormatSelection;
      input: FileFormat & { handler: string };
      inputSelection: RemoteFormatSelection;
      inputReason: string;
      rankScore: number;
      preview: RemoteRoutePreview;
    }>;
  }>;
  planConversion: (args: {
    from: RemoteFormatSelection;
    to: RemoteFormatSelection;
    simpleMode?: boolean;
  }) => Promise<RemotePlanResult>;
  previewConversionResult: (args: {
    from?: RemoteFormatSelection;
    to: RemoteFormatSelection;
    fileName?: string;
    mimeType?: string;
    simpleMode?: boolean;
  }) => Promise<RemoteRoutePreviewResult>;
  explainConversion: (args: {
    from?: RemoteFormatSelection;
    to: RemoteFormatSelection;
    fileName?: string;
    mimeType?: string;
    simpleMode?: boolean;
  }) => Promise<RemoteRoutePreviewResult>;
  suggestConversion: (args: {
    from?: RemoteFormatSelection;
    fileName?: string;
    mimeType?: string;
    goal: string;
    simpleMode?: boolean;
    limit?: number;
  }) => Promise<RemoteApiResult & {
    goal?: string;
    suggestions?: Array<{
      output: FileFormat & { handler: string };
      outputSelection: RemoteFormatSelection;
      input: FileFormat & { handler: string };
      inputSelection: RemoteFormatSelection;
      inputReason: string;
      rankScore: number;
      preview: RemoteRoutePreview;
      suggestionScore: number;
      why: string;
    }>;
  }>;
  convert: (args: {
    files: RemoteFileInput[];
    from: RemoteFormatSelection;
    to: RemoteFormatSelection;
    simpleMode?: boolean;
  }) => Promise<RemoteConvertResult>;
}

declare global {
  interface Window {
    supportedFormatCache: Map<string, FileFormat[]>;
    supportedFormatCacheVersions: Map<string, string>;
    traversionGraph: TraversionGraph;
    printSupportedFormatCache: () => string;
    showPopup: (html: string) => void;
    hidePopup: () => void;
    tryConvertByTraversing: (files: FileData[], from: ConvertPathNode, to: ConvertPathNode) => Promise<{
      files: FileData[];
      path: ConvertPathNode[];
    } | null>;
    convertApi: ConvertRemoteApi;
  }
}

export { };
