export declare function cliShare(filePath: string, options: {
    ttl?: string;
    max?: string | number;
    inline?: boolean;
    domain?: string;
    config?: string;
}): Promise<void>;
export declare function cliReceive(options: {
    dir?: string;
    ttl?: string;
    max?: string | number;
    domain?: string;
    config?: string;
}): Promise<void>;
export declare function cliList(options?: {
    config?: string;
}): Promise<void>;
export declare function cliRevoke(code: string, options?: {
    config?: string;
}): Promise<void>;
export declare function cliPrune(options?: {
    config?: string;
}): Promise<void>;
