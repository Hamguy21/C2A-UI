import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import CommonFormats from "src/CommonFormats.ts";

const RPG_MAKER_HEADER_LENGTH = 16;
const RPG_MAKER_FAKE_HEADER = new Uint8Array([
    0x52, 0x50, 0x47, 0x4d, 0x56, 0x00, 0x00, 0x00,
    0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00
]);
const PNG_HEADER = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

function getKeyFromEncryptedPng(bytes: Uint8Array): Uint8Array {
    if (bytes.length < RPG_MAKER_HEADER_LENGTH * 2) {
        throw new Error("RPGMVP file is too short to contain an encryption header.");
    }

    const key = new Uint8Array(RPG_MAKER_HEADER_LENGTH);
    for (let index = 0; index < RPG_MAKER_HEADER_LENGTH; index++) {
        key[index] = bytes[RPG_MAKER_HEADER_LENGTH + index] ^ PNG_HEADER[index];
    }

    return key;
}

function decryptRpgmvp(bytes: Uint8Array, key: Uint8Array): Uint8Array {
    if (bytes.length < RPG_MAKER_HEADER_LENGTH) {
        throw new Error("RPGMVP file is too short to decrypt.");
    }

    for (let index = 0; index < RPG_MAKER_HEADER_LENGTH; index++) {
        if (bytes[index] !== RPG_MAKER_FAKE_HEADER[index]) {
            throw new Error("Invalid RPGMVP header.");
        }
    }

    const output = bytes.slice(RPG_MAKER_HEADER_LENGTH);
    for (let index = 0; index < Math.min(RPG_MAKER_HEADER_LENGTH, output.length); index++) {
        output[index] ^= key[index];
    }

    return output;
}

class rpgmvpHandler implements FormatHandler {

    public name: string = "rpgmvp";
    public supportedFormats?: FileFormat[];
    public ready: boolean = false;

    async init() {
        this.supportedFormats = [
            {
                name: "RPG Maker MV PNG (RPGMVP)",
                format: "rpgmvp",
                extension: "rpgmvp",
                mime: "application/x-rpgmvp",
                from: true,
                to: false,
                internal: "rpgmvp",
                category: "image",
                lossless: true
            },
            CommonFormats.PNG.builder("png")
                .markLossless().allowFrom(false).allowTo(true),
        ];
        this.ready = true;
    }

    async doConvert(
        inputFiles: FileData[],
        inputFormat: FileFormat,
        outputFormat: FileFormat
    ): Promise<FileData[]> {
        const outputFiles: FileData[] = [];

        if (inputFormat.internal !== "rpgmvp" || outputFormat.internal !== "png") {
            throw Error("Invalid input/output format.");
        }

        for (const inputFile of inputFiles) {
            const bytes = inputFile.bytes;
            const encryptionKey = getKeyFromEncryptedPng(bytes);
            const decryptedBytes = decryptRpgmvp(bytes, encryptionKey);
            const name = inputFile.name.split(".").slice(0, -1).join(".") + "." + outputFormat.extension;

            outputFiles.push({ bytes: decryptedBytes, name });
        }

        return outputFiles;
    }

}

export default rpgmvpHandler;