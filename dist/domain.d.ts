import type { IncomingMessage } from "node:http";
export declare function detectActiveDomain(): string;
export declare function requestOrigin(req: IncomingMessage): string;
