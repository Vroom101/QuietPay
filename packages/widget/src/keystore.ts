import { bytesToHex } from "viem";
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
 */

const DB_NAME = "quietpay-wallet";
const STORE = "keys";
const RECORD_ID = "default";

interface KeyRecord {
  aesKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export interface KeystoreOptions {
  /** Override for tests. */
  indexedDB?: IDBFactory;
  dbName?: string;
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

async function readRecord(db: IDBDatabase): Promise<KeyRecord | undefined> {
  const tx = db.transaction(STORE, "readonly");
  return (await idbRequest(tx.objectStore(STORE).get(RECORD_ID))) as KeyRecord | undefined;
}

async function writeRecord(db: IDBDatabase, rec: KeyRecord): Promise<void> {
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(rec, RECORD_ID);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Returns the stored account, creating and persisting a new one on first use. */
export async function getOrCreateAccount(opts: KeystoreOptions = {}): Promise<PrivateKeyAccount> {
  const db = await openDb(opts);
  try {
    const existing = await readRecord(db);
    if (existing) {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: existing.iv },
        existing.aesKey,
        existing.ciphertext,
      );
      return privateKeyToAccount(bytesToHex(new Uint8Array(plain)));
    }

    const raw = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32)));
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, raw);
    const account = privateKeyToAccount(bytesToHex(raw));
    await writeRecord(db, { aesKey, iv, ciphertext });
    raw.fill(0);
    return account;
  } finally {
    db.close();
  }
}
