// op-sqlite's own declarations import their siblings without file extensions, which NodeNext resolution does not
// follow. This declares the part of op-sqlite 19 that the React Native store uses.
declare module '@op-engineering/op-sqlite' {
  export type Scalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView;
  export interface DB {
    executeRaw(query: string, params?: Scalar[]): Promise<{ rowsAffected: number; rawRows: Scalar[][] }>;
    close(): void;
    delete(): void;
  }
  export function open(options: { name: string; location?: string; encryptionKey?: string }): DB;
}
