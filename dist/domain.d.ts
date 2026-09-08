import type { IncomingMessage } from "node:http";
export declare function recordSeenHost(hostHeader?: string): void;
export declare function getRecordedHost(): string | null;
export declare function detectActiveDomain(): string;
export declare function requestOrigin(req: IncomingMessage): string;
