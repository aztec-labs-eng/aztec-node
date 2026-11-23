/// <reference lib="webworker" />
import type {
  FilesClose,
  FilesCloseResponse,
  FilesExists,
  FilesExistsResponse,
  FilesOpen,
  FilesOpenResponse,
  FilesRead,
  FilesReadResponse,
  FilesRemove,
  FilesRemoveResponse,
  FilesSize,
  FilesSizeResponse,
  FilesSync,
  FilesSyncResponse,
  FilesTruncate,
  FilesTruncateResponse,
  FilesWrite,
  FilesWriteResponse,
  SyncHandler,
} from '@aztec-labs/kv-sqlite-files';

// The pool layout of SQLite's opfs-sahpool VFS (the vendored sqlite3mc-wasm's `OpfsSAHPool`), which every browser
// store so far was written in, kept byte for byte so those stores open unchanged. A pool directory holds a fixed set
// of randomly named files under `.opaque/`, each with a header naming the SQLite file it holds, if any:
//
//   bytes [0, 512)    logical path, NUL-terminated UTF-8
//   bytes [512, 516)  SQLite open flags, big-endian uint32
//   bytes [516, 524)  digest over the preceding 516 bytes, two uint32 words in platform (little-endian) order
//
// and the file's content from byte 4096. pool_integrity.ts reads the same headers.
const OPAQUE_DIRECTORY = '.opaque';
const HEADER_MAX_PATH_SIZE = 512;
const HEADER_OFFSET_FLAGS = HEADER_MAX_PATH_SIZE;
const HEADER_CORPUS_SIZE = HEADER_MAX_PATH_SIZE + 4;
const HEADER_OFFSET_DIGEST = HEADER_CORPUS_SIZE;
const HEADER_OFFSET_DATA = 4096;

// sqlite3.h's open flags.
const SQLITE_OPEN_CREATE = 0x00000004;
const SQLITE_OPEN_DELETEONCLOSE = 0x00000008;
const SQLITE_OPEN_EXCLUSIVE = 0x00000010;
const SQLITE_OPEN_MEMORY = 0x00000080;
const SQLITE_OPEN_MAIN_DB = 0x00000100;
const SQLITE_OPEN_MAIN_JOURNAL = 0x00000800;
const SQLITE_OPEN_SUPER_JOURNAL = 0x00004000;
const SQLITE_OPEN_WAL = 0x00080000;
const PERSISTENT_FILE_TYPES =
  SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_SUPER_JOURNAL | SQLITE_OPEN_WAL;
// The pool repurposes SQLITE_OPEN_MEMORY, meaningless for a file on disk, to mark a header that carries a digest.
const FLAG_COMPUTE_DIGEST_V2 = SQLITE_OPEN_MEMORY;

/** The files a store needs at once (the database and its journal), with room to spare, as the pool always kept. */
const MINIMUM_CAPACITY = 8;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface OpenFile {
  path: string;
  flags: number;
  sah: FileSystemSyncAccessHandle;
}

/**
 * The Kv service's `files` host-call target over an OPFS SAH pool, answering synchronously through sync access
 * handles (a dedicated worker's only). Holds every handle of the pool from `open` until `release`, so one store at
 * a time uses a pool directory; the store's Web Lock (pool_lock.ts) guards that across contexts.
 */
export class OpfsSahPoolFiles implements SyncHandler {
  readonly #names = new Map<FileSystemSyncAccessHandle, string>();
  readonly #byPath = new Map<string, FileSystemSyncAccessHandle>();
  readonly #free = new Set<FileSystemSyncAccessHandle>();
  readonly #open = new Map<number, OpenFile>();
  readonly #header = new Uint8Array(HEADER_CORPUS_SIZE);
  readonly #headerView = new DataView(this.#header.buffer);
  #nextHandle = 1;

  private constructor(private readonly opaque: FileSystemDirectoryHandle) {}

  /** Takes every file of the pool at `directory` (creating it, and files up to its minimum capacity). */
  static async open(directory: string): Promise<OpfsSahPoolFiles> {
    let dir = await navigator.storage.getDirectory();
    for (const segment of directory.split('/')) {
      if (segment) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
      }
    }
    const pool = new OpfsSahPoolFiles(await dir.getDirectoryHandle(OPAQUE_DIRECTORY, { create: true }));
    try {
      await pool.#acquire();
      while (pool.#names.size < MINIMUM_CAPACITY) {
        await pool.#addFile();
      }
    } catch (err) {
      pool.release();
      throw err;
    }
    return pool;
  }

  /** Closes every handle of the pool, without touching its files. */
  release(): void {
    for (const sah of this.#names.keys()) {
      sah.close();
    }
    this.#names.clear();
    this.#byPath.clear();
    this.#free.clear();
    this.#open.clear();
  }

  open({ path, flags }: FilesOpen): FilesOpenResponse {
    flags &= ~FLAG_COMPUTE_DIGEST_V2;
    path = poolPath(path);
    let sah = this.#byPath.get(path);
    if (sah && flags & SQLITE_OPEN_CREATE && flags & SQLITE_OPEN_EXCLUSIVE) {
      throw new Error(`file already exists: ${path}`);
    }
    if (!sah && flags & SQLITE_OPEN_CREATE) {
      sah = this.#free.values().next().value;
      if (!sah) {
        throw new Error(`SAH pool is full. Cannot create file ${path}`);
      }
      this.#associate(sah, path, flags);
    }
    if (!sah) {
      throw new Error(`file not found: ${path}`);
    }
    const handle = this.#nextHandle++;
    this.#open.set(handle, { path, flags, sah });
    return { handle };
  }

  close({ handle }: FilesClose): FilesCloseResponse {
    const file = this.#file(handle);
    this.#open.delete(handle);
    file.sah.flush();
    if (file.flags & SQLITE_OPEN_DELETEONCLOSE) {
      this.#deletePath(file.path);
    }
    return {};
  }

  read({ handle, offset, length }: FilesRead): FilesReadResponse {
    const data = new Uint8Array(length);
    const n = this.#file(handle).sah.read(data, { at: HEADER_OFFSET_DATA + Number(offset) });
    return { data: data.subarray(0, n) };
  }

  write({ handle, offset, data }: FilesWrite): FilesWriteResponse {
    const n = this.#file(handle).sah.write(data, { at: HEADER_OFFSET_DATA + Number(offset) });
    if (n !== data.length) {
      throw new Error(`short write: ${n} of ${data.length} bytes`);
    }
    return {};
  }

  truncate({ handle, size }: FilesTruncate): FilesTruncateResponse {
    this.#file(handle).sah.truncate(HEADER_OFFSET_DATA + Number(size));
    return {};
  }

  size({ handle }: FilesSize): FilesSizeResponse {
    return { size: Math.max(0, this.#file(handle).sah.getSize() - HEADER_OFFSET_DATA) };
  }

  sync({ handle }: FilesSync): FilesSyncResponse {
    this.#file(handle).sah.flush();
    return {};
  }

  remove({ path }: FilesRemove): FilesRemoveResponse {
    this.#deletePath(poolPath(path));
    return {};
  }

  exists({ path }: FilesExists): FilesExistsResponse {
    return { exists: this.#byPath.has(poolPath(path)) };
  }

  #file(handle: number): OpenFile {
    const file = this.#open.get(handle);
    if (!file) {
      throw new Error(`no open file ${handle}`);
    }
    return file;
  }

  async #acquire(): Promise<void> {
    for await (const [name, entry] of this.opaque.entries()) {
      if (entry.kind !== 'file') {
        continue;
      }
      const sah = await (entry as FileSystemFileHandle).createSyncAccessHandle();
      this.#names.set(sah, name);
      const path = this.#associatedPath(sah);
      if (path) {
        this.#byPath.set(path, sah);
      } else {
        this.#free.add(sah);
      }
    }
  }

  async #addFile(): Promise<void> {
    const name = Math.random().toString(36).slice(2);
    const sah = await (await this.opaque.getFileHandle(name, { create: true })).createSyncAccessHandle();
    this.#names.set(sah, name);
    this.#associate(sah, '', 0);
  }

  /** The path a pool file holds, or '' for a free one: a header the pool would not trust is freed, as the pool does. */
  #associatedPath(sah: FileSystemSyncAccessHandle): string {
    this.#header.fill(0);
    sah.read(this.#header, { at: 0 });
    const flags = this.#headerView.getUint32(HEADER_OFFSET_FLAGS);
    if (this.#header[0] && (flags & SQLITE_OPEN_DELETEONCLOSE || (flags & PERSISTENT_FILE_TYPES) === 0)) {
      this.#associate(sah, '', 0);
      return '';
    }
    const stored = new Uint32Array(2);
    sah.read(stored, { at: HEADER_OFFSET_DIGEST });
    const expected = digest(this.#header, flags);
    if (stored[0] !== expected[0] || stored[1] !== expected[1]) {
      this.#associate(sah, '', 0);
      return '';
    }
    const length = this.#header.indexOf(0);
    if (length === 0) {
      sah.truncate(HEADER_OFFSET_DATA);
      return '';
    }
    return textDecoder.decode(this.#header.subarray(0, length === -1 ? HEADER_MAX_PATH_SIZE : length));
  }

  #associate(sah: FileSystemSyncAccessHandle, path: string, flags: number): void {
    this.#header.fill(0);
    const { written } = textEncoder.encodeInto(path, this.#header);
    if (written + 1 >= HEADER_MAX_PATH_SIZE) {
      throw new Error(`Path too long: ${path}`);
    }
    if (path && flags) {
      flags |= FLAG_COMPUTE_DIGEST_V2;
    }
    this.#headerView.setUint32(HEADER_OFFSET_FLAGS, flags);
    sah.write(this.#header, { at: 0 });
    sah.write(digest(this.#header, flags), { at: HEADER_OFFSET_DIGEST });
    sah.flush();
    if (path) {
      this.#byPath.set(path, sah);
      this.#free.delete(sah);
    } else {
      sah.truncate(HEADER_OFFSET_DATA);
      this.#free.add(sah);
    }
  }

  #deletePath(path: string): void {
    const sah = this.#byPath.get(path);
    if (sah) {
      this.#byPath.delete(path);
      this.#associate(sah, '', 0);
    }
  }
}

/** The pool's form of a path: its URL pathname, as the pool resolved every name it was given. */
function poolPath(path: string): string {
  return new URL(path, 'file://localhost/').pathname;
}

/** The pool's header digest (`computeDigest`): zero words for a header without FLAG_COMPUTE_DIGEST_V2. */
function digest(corpus: Uint8Array, flags: number): Uint32Array {
  if (!(flags & FLAG_COMPUTE_DIGEST_V2)) {
    return new Uint32Array([0, 0]);
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const v of corpus) {
    h1 = Math.imul(h1 ^ v, 2654435761);
    h2 = Math.imul(h2 ^ v, 104729);
  }
  return new Uint32Array([h1 >>> 0, h2 >>> 0]);
}
