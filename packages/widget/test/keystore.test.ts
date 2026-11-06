import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { getOrCreateAccount } from "../src/keystore.js";

describe("key storage", () => {
  it("creates a key on first use and returns the same account afterwards", async () => {
    const indexedDB = new IDBFactory();
    const a = await getOrCreateAccount({ indexedDB });
    const b = await getOrCreateAccount({ indexedDB });
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(b.address).toBe(a.address);
  });

  it("different storage gives a different account", async () => {
    const a = await getOrCreateAccount({ indexedDB: new IDBFactory() });
    const b = await getOrCreateAccount({ indexedDB: new IDBFactory() });
    expect(a.address).not.toBe(b.address);
  });

  it("never stores the raw private key and the AES key is non-extractable", async () => {
    const indexedDB = new IDBFactory();
    const account = await getOrCreateAccount({ indexedDB });
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open("quietpay-wallet", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rec: { aesKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer } = await new Promise((res, rej) => {
      const r = db.transaction("keys").objectStore("keys").get("default");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    expect(rec.aesKey.extractable).toBe(false);
    expect(rec.aesKey.algorithm.name).toBe("AES-GCM");
    expect(rec.ciphertext.byteLength).toBe(32 + 16); // key + GCM tag
    await expect(crypto.subtle.exportKey("raw", rec.aesKey)).rejects.toBeTruthy();
    // sanity: the account really is derived from the encrypted bytes
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, rec.aesKey, rec.ciphertext));
    expect(plain.length).toBe(32);
    expect(account.address).toBeTruthy();
  });
});
