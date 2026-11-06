import { bytesToHex, hexToBytes, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * DEMO-GRADE browser key storage.
 *
 * WebCrypto cannot do secp256k1, so we generate a random 32-byte private key,
 * encrypt it with a non-extractable AES-GCM CryptoKey, and keep the CryptoKey,
 * IV and ciphertext together in IndexedDB. The AES key cannot be exported by
 * script, but any code running on this origin can still ask the browser to
 * decrypt, so this only protects against casual disk/storage inspection.
 * See docs/a/limitations.md.
 *
 * Loss protection:
 * - An existing record is NEVER overwritten implicitly. If it cannot be read or decrypted,
 *   getOrCreateAccount throws KeystoreError("unreadable") instead of minting a new key, because
 *   funds may still sit at the old address.
 * - New keys are written with IndexedDB `add`, so two tabs/elements racing on first use end up
 *   with the same single key rather than one silently replacing the other.
 * - After a key is stored we ask the browser to make storage persistent (best effort), so it is
 *   less likely to be evicted under storage pressure.
 * - exportBackup / importAccount give the host page an explicit, user-initiated backup path.
 *
 * The private key is never written to localStorage, sessionStorage, cookies, logs, events or
 * error messages.
 */

const DB_NAME = "quietpay-wallet";
const STORE = "keys";
const RECORD_ID = "default";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;

interface KeyRecord {
  aesKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export type KeystoreErrorCode =
  /** A record exists but is malformed or cannot be decrypted. It was left untouched. */
  | "unreadable"
  /** importAccount found an existing record and overwrite was not requested. */
  | "exists"
  /** exportBackup found no wallet. */
  | "not_found"
  /** importAccount got something that is not a valid secp256k1 private key. */
  | "invalid_key"
  /** exportBackup was called without acknowledgeRisk: true. */
  | "not_acknowledged"
  /** exportBackup was called outside a user gesture (browsers exposing navigator.userActivation only). */
  | "no_user_gesture";

/** Keystore failure with a stable code. Messages never contain key material. */
export class KeystoreError extends Error {
  constructor(
    public readonly code: KeystoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "KeystoreError";
  }
}

export interface KeystoreOptions {
  /** Override for tests. */
  indexedDB?: IDBFactory;
  dbName?: string;
  /** Override for tests; defaults to navigator.storage. Only persist() is used. */
  storage?: Pick<StorageManager, "persist">;
}

function openDb(opts: KeystoreOptions): Promise<IDBDatabase> {
  const factory = opts.indexedDB ?? globalThis.indexedDB;
  return new Promise((resolve, reject) => {
    const req = factory.open(opts.dbName ?? DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Whether a record exists at all (any value, even garbage), plus the raw value. */
async function readRaw(db: IDBDatabase): Promise<{ exists: boolean; value: unknown }> {
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const count = await idbRequest(store.count(RECORD_ID));
  if (count === 0) return { exists: false, value: undefined };
  return { exists: true, value: await idbRequest(store.get(RECORD_ID)) };
}

/**
 * Writes the record. With `overwrite` false it uses `add`, which fails if a record already exists
 * (returns false) so a concurrent creator can never be clobbered.
 */
async function writeRecord(db: IDBDatabase, rec: KeyRecord, overwrite: boolean): Promise<boolean> {
  const tx = db.transaction(STORE, "readwrite");
  const req = overwrite ? tx.objectStore(STORE).put(rec, RECORD_ID) : tx.objectStore(STORE).add(rec, RECORD_ID);
  return new Promise<boolean>((resolve, reject) => {
    req.onerror = (ev) => {
      if (req.error?.name === "ConstraintError") {
        ev.preventDefault(); // keep the error from also surfacing as a transaction error
        resolve(false);
      }
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => (req.error?.name === "ConstraintError" ? resolve(false) : reject(tx.error));
  });
}

function isCryptoKey(k: unknown): k is CryptoKey {
  if (typeof CryptoKey !== "undefined" && k instanceof CryptoKey) return true;
  // Cross-realm fallback (e.g. Node WebCrypto keys inside jsdom).
  return !!k && typeof k === "object" && Object.prototype.toString.call(k) === "[object CryptoKey]";
}

function isRecord(v: unknown): v is KeyRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<KeyRecord>;
  return (
    isCryptoKey(r.aesKey) &&
    ArrayBuffer.isView(r.iv) &&
    r.iv.byteLength === IV_BYTES &&
    (r.ciphertext instanceof ArrayBuffer || Object.prototype.toString.call(r.ciphertext) === "[object ArrayBuffer]") &&
    (r.ciphertext as ArrayBuffer).byteLength === KEY_BYTES + GCM_TAG_BYTES
  );
}

/** Decrypts a stored record to raw key bytes. Throws KeystoreError("unreadable") on any problem. Caller zeroes. */
async function decryptRecord(value: unknown): Promise<Uint8Array> {
  if (!isRecord(value)) throw new KeystoreError("unreadable", "stored wallet record is malformed");
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(value.iv) }, value.aesKey, value.ciphertext),
    );
  } catch {
    throw new KeystoreError("unreadable", "stored wallet record cannot be decrypted");
  }
  if (plain.length !== KEY_BYTES) {
    plain.fill(0);
    throw new KeystoreError("unreadable", "stored wallet record has the wrong length");
  }
  return plain;
}

function accountFromBytes(raw: Uint8Array, onInvalid: KeystoreErrorCode): PrivateKeyAccount {
  try {
    return privateKeyToAccount(bytesToHex(raw));
  } catch {
    // e.g. zero or >= curve order. Never include the bytes in the message.
    throw new KeystoreError(onInvalid, onInvalid === "unreadable" ? "stored wallet key is not a valid key" : "not a valid private key");
  }
}

async function encrypt(raw: Uint8Array<ArrayBuffer>): Promise<KeyRecord> {
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, raw);
  return { aesKey, iv, ciphertext };
}

/** Best effort: ask the browser not to evict our storage. Never throws. */
async function requestPersistence(opts: KeystoreOptions): Promise<void> {
  try {
    const storage = opts.storage ?? (globalThis.navigator as Navigator | undefined)?.storage;
    if (storage && typeof storage.persist === "function") await storage.persist();
  } catch {
    // Not available or denied; the key is still stored.
  }
}

/** Reads and decrypts the existing record, or returns undefined when none exists. Throws "unreadable" otherwise. */
async function loadExisting(db: IDBDatabase): Promise<PrivateKeyAccount | undefined> {
  const { exists, value } = await readRaw(db);
  if (!exists) return undefined;
  const raw = await decryptRecord(value);
  try {
    return accountFromBytes(raw, "unreadable");
  } finally {
    raw.fill(0);
  }
}

/**
 * Returns the stored account, creating and persisting a new one only when no record exists.
 * Throws KeystoreError("unreadable") if a record exists but cannot be used; it is never replaced here.
 */
export async function getOrCreateAccount(opts: KeystoreOptions = {}): Promise<PrivateKeyAccount> {
  const db = await openDb(opts);
  try {
    const existing = await loadExisting(db);
    if (existing) return existing;

    const raw = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(KEY_BYTES)));
    try {
      const account = accountFromBytes(raw, "invalid_key");
      const written = await writeRecord(db, await encrypt(raw), false);
      if (!written) {
        // Another caller created a key first; use theirs.
        const theirs = await loadExisting(db);
        if (!theirs) throw new KeystoreError("unreadable", "stored wallet record vanished");
        return theirs;
      }
      await requestPersistence(opts);
      return account;
    } finally {
      raw.fill(0);
    }
  } finally {
    db.close();
  }
}

export interface ExportBackupOptions extends KeystoreOptions {
  /**
   * Must be exactly true. The caller confirms that the user asked to see their private key and understands that
   * anyone who obtains it can spend everything at this address.
   */
  acknowledgeRisk: true;
  /** Override for tests; defaults to navigator.userActivation where the browser has it. */
  userActivation?: { isActive: boolean };
}

/**
 * Returns the stored private key as a 0x-prefixed hex string so the user can back it up.
 *
 * RISK: this reveals the raw key. Whoever holds it controls the wallet's funds. Call it only from a click handler the
 * user triggered on purpose (e.g. "Back up my wallet"), show the result only to that user, and never log it, send it
 * to a server, put it in a URL, or store it in localStorage/sessionStorage/cookies. In browsers that expose
 * navigator.userActivation the call is refused outside a user gesture. The element never calls this itself.
 */
export async function exportBackup(opts: ExportBackupOptions): Promise<Hex> {
  if (opts?.acknowledgeRisk !== true) throw new KeystoreError("not_acknowledged", "exportBackup requires acknowledgeRisk: true");
  const activation = opts.userActivation ?? (globalThis.navigator as (Navigator & { userActivation?: { isActive: boolean } }) | undefined)?.userActivation;
  if (activation && !activation.isActive) throw new KeystoreError("no_user_gesture", "exportBackup must run inside a user gesture");
  const db = await openDb(opts);
  try {
    const { exists, value } = await readRaw(db);
    if (!exists) throw new KeystoreError("not_found", "no wallet stored in this browser");
    const raw = await decryptRecord(value);
    try {
      accountFromBytes(raw, "unreadable");
      return bytesToHex(raw);
    } finally {
      raw.fill(0);
    }
  } finally {
    db.close();
  }
}

export interface ImportAccountOptions extends KeystoreOptions {
  /** Replace an existing record (readable or not). Without it, import refuses when any record exists. */
  overwrite?: boolean;
}

/**
 * Stores `privateKeyHex` (0x + 64 hex chars) as this browser's wallet, encrypted like a generated key. Refuses with
 * KeystoreError("exists") when a record is already present unless `overwrite: true` is passed, because replacing it
 * would strand any funds at the old address.
 */
export async function importAccount(privateKeyHex: Hex, opts: ImportAccountOptions = {}): Promise<PrivateKeyAccount> {
  if (typeof privateKeyHex !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new KeystoreError("invalid_key", "not a valid private key");
  }
  const raw = new Uint8Array(hexToBytes(privateKeyHex));
  try {
    const account = accountFromBytes(raw, "invalid_key");
    const db = await openDb(opts);
    try {
      if (!opts.overwrite && (await readRaw(db)).exists) {
        throw new KeystoreError("exists", "a wallet is already stored in this browser");
      }
      const written = await writeRecord(db, await encrypt(raw), opts.overwrite === true);
      if (!written) throw new KeystoreError("exists", "a wallet is already stored in this browser");
    } finally {
      db.close();
    }
    await requestPersistence(opts);
    return account;
  } finally {
    raw.fill(0);
  }
}
