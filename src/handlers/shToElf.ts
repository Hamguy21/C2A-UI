// file: shToElf.ts

import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats, { Category } from "src/CommonFormats.ts";

import elfUrl from "./shToElf/stub.elf?url";

function uint32ToBytesLE (value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function findSubarrayIndex (source: Uint8Array, target: Uint8Array) {
  const limit = source.length - target.length;

  for (let index = 0; index <= limit; index++) {
    let match = true;

    for (let offset = 0; offset < target.length; offset++) {
      if (source[index + offset] !== target[offset]) {
        match = false;
        break;
      }
    }

    if (match) return index;
  }

  return -1;
}

function replaceUint32LE (file: Uint8Array, from: number, to: number) {
  const fromBytes = uint32ToBytesLE(from);
  const toBytes = uint32ToBytesLE(to);
  const index = findSubarrayIndex(file, fromBytes);

  if (index < 0) {
    throw new Error(`Could not find placeholder ${from} in ELF stub.`);
  }

  file.set(toBytes, index);
}

function concatBytes (...parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

class shToElfHandler implements FormatHandler {

  public name: string = "shToElf";
  public supportedFormats: FileFormat[] = [
    CommonFormats.SH.builder("sh").allowFrom().markLossless(),
    {
      name: "x86-64 Linux Executable and Linkable Format",
      format: "elf",
      extension: "elf",
      mime: "application/x-elf",
      from: false,
      to: true,
      internal: "elf",
      category: Category.CODE,
    }
  ];
  public ready: boolean = false;

  #binary?: Uint8Array;

  async init () {
    this.ready = true;
    this.#binary = new Uint8Array(await (await fetch(elfUrl)).arrayBuffer());
  }

  async doConvert (
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {
      const binary = new Uint8Array(this.#binary!);
      replaceUint32LE(binary, 1273991571, inputFile.bytes.length);

      const file = concatBytes(
        binary,
        inputFile.bytes
      );

      outputFiles.push({ 
        name: inputFile.name.replace(/\.[^.]+$/, "") + ".elf",
        bytes: file
      });
    }

    return outputFiles;
  }

}

export default shToElfHandler;