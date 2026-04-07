import CommonFormats from "src/CommonFormats.ts";
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

type GrayscaleImage = {
  width: () => number;
  height: () => number;
  getPixel: (x: number, y: number) => number;
};

function rgbaToGrayscale (red: number, green: number, blue: number, alpha: number): number {
  const blended = (1 - alpha) + alpha * (0.299 * red + 0.587 * green + 0.114 * blue);
  return Math.max(0, Math.min(1, blended));
}

function imageToText (image: GrayscaleImage): string {
  const ramp = "@%#*+=-:. ";
  const width = image.width();
  const height = image.height();
  const sampleWidth = Math.max(1, Math.floor(width / 120));
  const sampleHeight = Math.max(1, Math.floor(sampleWidth * 2));
  const rows: string[] = [];

  for (let y = 0; y < height; y += sampleHeight) {
    let row = "";

    for (let x = 0; x < width; x += sampleWidth) {
      let total = 0;
      let samples = 0;

      for (let sampleY = y; sampleY < Math.min(y + sampleHeight, height); sampleY++) {
        for (let sampleX = x; sampleX < Math.min(x + sampleWidth, width); sampleX++) {
          total += image.getPixel(sampleX, sampleY);
          samples++;
        }
      }

      const value = samples === 0 ? 1 : total / samples;
      const index = Math.min(ramp.length - 1, Math.floor(value * (ramp.length - 1)));
      row += ramp[index];
    }

    rows.push(row.trimEnd());
  }

  return rows.join("\n");
}

class canvasToBlobHandler implements FormatHandler {

  public name: string = "canvasToBlob";

  public supportedFormats: FileFormat[] = [
    CommonFormats.PNG.supported("png", true, true, true),
    CommonFormats.JPEG.supported("jpeg", true, true),
    CommonFormats.WEBP.supported("webp", true, true),
    CommonFormats.GIF.supported("gif", true, false),
    CommonFormats.SVG.supported("svg", true, false),
    CommonFormats.TEXT.supported("text", true, true)
  ];

  #canvas?: HTMLCanvasElement;
  #ctx?: CanvasRenderingContext2D;

  public ready: boolean = false;

  async init () {
    this.#canvas = document.createElement("canvas");
    this.#ctx = this.#canvas.getContext("2d") || undefined;
    this.ready = true;
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {

    if (!this.#canvas || !this.#ctx) {
      throw "Handler not initialized.";
    }

    const outputFiles: FileData[] = [];
    for (const inputFile of inputFiles) {

      if (inputFormat.mime === "text/plain") {

        const font = "48px sans-serif";
        const fontSize = parseInt(font);
        const footerPadding = fontSize * 0.5;
        const string = new TextDecoder().decode(inputFile.bytes);
        const lines = string.split("\n");

        this.#ctx.font = font;

        let maxLineWidth = 0;
        for (const line of lines) {
          const width = this.#ctx.measureText(line).width;
          if (width > maxLineWidth) maxLineWidth = width;
        }

        this.#canvas.width = maxLineWidth;
        this.#canvas.height = Math.floor(fontSize * lines.length + footerPadding);

        if (outputFormat.mime === "image/jpeg") {
          this.#ctx.fillStyle = "white";
          this.#ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
        }
        this.#ctx.fillStyle = "black";
        this.#ctx.strokeStyle = "white";
        this.#ctx.font = font;

        for (let i = 0; i < lines.length; i ++) {
          const line = lines[i];
          this.#ctx.fillText(line, 0, fontSize * (i + 1));
          this.#ctx.strokeText(line, 0, fontSize * (i + 1));
        }

      } else {

        const blob = new Blob([inputFile.bytes as BlobPart], { type: inputFormat.mime });
        // For SVG, convert to data URL to avoid "Tainted canvases may not be exported" error
        const url =
          inputFormat.mime === "image/svg+xml"
            ? `data:${inputFormat.mime};base64,${btoa(inputFile.bytes.reduce((str, byte) => str + String.fromCharCode(byte), ''))}`
            : URL.createObjectURL(blob);

        const image = new Image();
        await new Promise((resolve, reject) => {
          image.addEventListener("load", resolve);
          image.addEventListener("error", reject);
          image.src = url;
        });

        this.#canvas.width = image.naturalWidth;
        this.#canvas.height = image.naturalHeight;
        this.#ctx.drawImage(image, 0, 0);

      }

      let bytes: Uint8Array;
      if(outputFormat.mime === "text/plain") {
        const pixels = this.#ctx.getImageData(0, 0, this.#canvas.width, this.#canvas.height);
        bytes = new TextEncoder().encode(imageToText({
          width() { return pixels.width; },
          height() { return pixels.height; },
          getPixel(x: number, y: number) {
            const index = (y*pixels.width + x)*4;
            return rgbaToGrayscale(pixels.data[index]/255, pixels.data[index+1]/255, pixels.data[index+2]/255, pixels.data[index+3]/255);
          }
        }));
      }
      else {
        bytes = await new Promise((resolve, reject) => {
          this.#canvas!.toBlob((blob) => {
            if (!blob) return reject("Canvas output failed");
            blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf)));
          }, outputFormat.mime);
        });
      }

      const name = inputFile.name.split(".").slice(0, -1).join(".") + "." + outputFormat.extension;

      outputFiles.push({ bytes, name });

    }

    return outputFiles;

  }

}

export default canvasToBlobHandler;
