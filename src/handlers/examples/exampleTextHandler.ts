import { FormatDefinition, type FileData, type FileFormat, type FormatHandler } from "src/FormatHandler";
import CommonFormats, { Category } from "src/CommonFormats.ts";

// Required imports for a normal handler file in src/handlers:
// - FormatHandler is the interface your handler must satisfy.
// - FileData/FileFormat are the types used by init() and doConvert().
// - CommonFormats gives you shared format definitions like TEXT and BATCH.
// - FormatDefinition/Category are only needed when you introduce a custom format.

function renderBatchScript (text: string) {
  const escaped = text
    .replaceAll("^", "^^")
    .replaceAll("%", "%%")
    .replaceAll("&", "^&")
    .replaceAll("|", "^|")
    .replaceAll("<", "^<")
    .replaceAll(">", "^>");
  const lines = escaped.split(/\r?\n/);
  const echos = lines.map(line => line.trim() === "" ? "echo.\r\n" : `echo ${line}\r\n`);
  return `@echo off\r\n${echos.join("")}pause\r\n`;
}

// Step 1:
// Define any custom formats that are specific to this handler.
// Use CommonFormats when a shared definition already exists, and create a
// new FormatDefinition only when the format is unique to your handler.
const UPPER_TEXT_FORMAT = new FormatDefinition(
  "Example Uppercase Text",
  "utxt",
  "utxt",
  "text/x-uppercase-example",
  Category.TEXT
);

// Step 2:
// Implement the FormatHandler interface.
// The registry discovers handlers by loading a top-level file from src/handlers
// and checking that the exported value looks like a valid FormatHandler.
class exampleTextHandler implements FormatHandler {
  // Step 3:
  // Give the handler a unique name. This is used in the registry, cache, path
  // planning, MCP APIs, and advanced-mode UI labels.
  public name = "exampleText";

  // Step 4:
  // supportedFormats starts empty and is populated during init().
  // The app uses these entries to build the from/to lists and conversion graph.
  public supportedFormats?: FileFormat[];

  // Step 5:
  // ready tells the app whether the handler has finished any setup work.
  // Keep this false until init() has completed successfully.
  public ready = false;

  async init () {
    // Step 6:
    // Publish every format edge this handler supports.
    // Each entry describes one format as this handler understands it, including:
    // - whether the format can be used as input (allowFrom)
    // - whether the format can be produced as output (allowTo)
    // - whether this route is lossless
    // If supportedFormats is never set, the handler will register but it will
    // not show up in the UI lists.
    this.supportedFormats = [
      // Step 6a:
      // Reuse a shared format definition from CommonFormats when possible.
      CommonFormats.TEXT.builder("text")
        .allowFrom(true)
        .allowTo(true)
        .markLossless(),

      // Step 6b:
      // Add the custom format defined above.
      // The internal string ("utxt") is the handler-local identifier you can
      // branch on later in doConvert().
      UPPER_TEXT_FORMAT.builder("utxt")
        .allowFrom(true)
        .allowTo(true)
        .markLossless(),

      // Step 6c:
      // You can also expose other outputs from the same handler.
      // Here we add Windows batch output so the example demonstrates a real
      // "text to source-like" route in addition to the custom format.
      CommonFormats.BATCH.builder("bat")
        .allowTo(true)
        .markLossless()
    ];

    // Step 7:
    // Mark the handler as ready after setup is complete.
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    _inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    // Step 8:
    // Perform the actual conversion.
    // The app passes all selected input files plus the chosen input/output
    // formats for this step in the traversal path.

    // Step 9:
    // Process files one-by-one and return one output per input file.
    // If the user selects multiple files, the app queues them through this
    // handler and saves all returned outputs into the same destination folder.
    // Most normal handlers in this repo follow this pattern.
    return inputFiles.map(file => {
      // Step 10:
      // Decode the incoming bytes into a string because this example works on
      // text data. Binary handlers would usually parse the Uint8Array directly.
      const source = new TextDecoder().decode(file.bytes);

      // Step 11:
      // Branch on the output format you want to produce.
      // In a real handler this is where you would call an external library,
      // parse a file structure, render an image, or run some codec logic.
      const outputText = outputFormat.internal === "utxt"
        ? source.toUpperCase()
        : outputFormat.internal === "bat"
          ? renderBatchScript(source)
          : source;

      return {
        // Step 12:
        // Decide the final output file name.
        // Most handlers only need to swap the extension, but the handler owns
        // the full name in case the target format has stricter naming rules.
        name: `${file.name.split(".").slice(0, -1).join(".") || file.name}.${outputFormat.extension}`,

        // Step 13:
        // Encode the converted content back into bytes for the next handler or
        // for the final download result.
        bytes: new TextEncoder().encode(outputText)
      };
    });
  }
}

// Step 14:
// In a real handler file under src/handlers, the simplest pattern is a default
// export. The copy-ready template below uses that exact shape.

// ======== EXAMPLE ============

const MY_FORMAT = new FormatDefinition(
  "My Custom Text Format",
  "myfmt",
  "myfmt",
  "text/x-my-format",
  Category.TEXT
);

class myFormatHandler implements FormatHandler {
  public name = "myFormat";
  public supportedFormats?: FileFormat[];
  public ready = false;

  async init () {
    this.supportedFormats = [
      CommonFormats.TEXT.builder("text")
        .allowFrom(true)
        .allowTo(true)
        .markLossless(),
      MY_FORMAT.builder("myfmt")
        .allowFrom(true)
        .allowTo(true)
        .markLossless(),
      CommonFormats.BATCH.builder("bat")
        .allowTo(true)
        .markLossless()
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
      const outputText = outputFormat.internal === "myfmt"
        ? source.toUpperCase()
        : outputFormat.internal === "bat"
          ? renderBatchScript(source)
        : source;

      return {
        name: `${file.name.split(".").slice(0, -1).join(".") || file.name}.${outputFormat.extension}`,
        bytes: new TextEncoder().encode(outputText)
      };
    });
  }
}

export default myFormatHandler;