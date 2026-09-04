import type { IncomingMessage } from "node:http";
import type { FileserverConfig } from "./types.js";
export declare function resolveDefaultWorkspace(): string;
export declare function resolveDefaultStateDir(): string;
export declare function resolveDefaultDataFiles(): {
    dataFile: string;
    uploadDataFile: string;
};
export declare function resolveConfigPath(configPath?: string): string | null;
export declare function getDefaultConfig(): FileserverConfig;
export declare function parseFlexibleDuration(s: string): number;
export declare function getDateMinuteSubdir(date?: Date): string;
export declare function resolveUploadTargetDir(specificDir?: string, date?: Date): string;
export declare function loadConfig(configPath?: string, overrides?: Partial<FileserverConfig>): FileserverConfig;
export declare function resolveBaseUrl(cfg: FileserverConfig, req?: IncomingMessage): string;
export declare function resolveUploadBaseUrl(cfg: FileserverConfig, req?: IncomingMessage): string;
