declare module '@leaningtech/cheerpx' {
  const CheerpX: {
    CloudDevice: {
      create(url: string): Promise<unknown>;
    };
    HttpBytesDevice: {
      create(url: string): Promise<unknown>;
    };
    IDBDevice: {
      create(name: string): Promise<{
        readFileAsBlob(path: string): Promise<Blob | null>;
        reset(): Promise<void>;
      }>;
    };
    OverlayDevice: {
      create(baseDevice: unknown, overlayDevice: unknown): Promise<unknown>;
    };
    WebDevice: {
      create(path: string): Promise<unknown>;
    };
    DataDevice: {
      create(): Promise<{
        writeFile(path: string, content: string | Uint8Array): Promise<void>;
      }>;
    };
    Linux: {
      create(options: {
        mounts: Array<{ type: string; path: string; dev?: unknown }>;
        networkInterface?: unknown;
      }): Promise<{
        run(
          fileName: string,
          args: string[],
          options?: {
            env?: string[];
            cwd?: string;
            uid?: number;
            gid?: number;
          },
        ): Promise<{ status: number }>;
        setCustomConsole(
          callback: (buf: ArrayBuffer | Uint8Array, vt?: number) => void,
          cols?: number,
          rows?: number,
        ): (charCode: number) => void;
        networkLogin?: () => Promise<void> | void;
      }>;
    };
  };

  export default CheerpX;
}
