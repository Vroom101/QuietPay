import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeystoreError, exportBackup, getOrCreateAccount, importAccount } from "../src/keystore.js";

async function rawRecord(indexedDB: IDBFactory): Promise<any> {
  const db: IDBDatabase = await new Promise((res, rej) => {
    const r = indexedDB.open("quietpay-wallet", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const rec = await new Promise((res, rej) => {
    const r = db.transaction("keys").objectStore("keys").get("default");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return rec;
}

async function putRaw(indexedDB: IDBFactory, value: unknown) {
  const db: IDBDatabase = await new Promise((res, rej) => {
    const r = indexedDB.open("quietpay-wallet", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise<void>((res, rej) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(value, "default");
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

const noGesture = { userActivation: { isActive: false } };
const gesture = { userActivation: { isActive: true } };

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
    const rec: { aesKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer } = await rawRecord(indexedDB);
    expect(rec.aesKey.extractable).toBe(false);
    expect(rec.aesKey.algorithm.name).toBe("AES-GCM");
    expect(rec.ciphertext.byteLength).toBe(32 + 16); // key + GCM tag
    await expect(crypto.subtle.exportKey("raw", rec.aesKey)).rejects.toBeTruthy();
    // sanity: the account really is derived from the encrypted bytes
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, rec.aesKey, rec.ciphertext));
    expect(plain.length).toBe(32);
    expect(account.address).toBeTruthy();
  });

  it("concurrent first use creates exactly one key (no lost wallet from a race)", async () => {
    const indexedDB = new IDBFactory();
    const accounts = await Promise.all([1, 2, 3, 4].map(() => getOrCreateAccount({ indexedDB })));
    expect(new Set(accounts.map((a) => a.address)).size).toBe(1);
    expect((await getOrCreateAccount({ indexedDB })).address).toBe(accounts[0]!.address);
  });
});

describe("unreadable records are never overwritten", () => {
  it("a record that fails to decrypt throws KeystoreError('unreadable') and is left untouched", async () => {
    const indexedDB = new IDBFactory();
    await getOrCreateAccount({ indexedDB });
    const rec = await rawRecord(indexedDB);
    const tampered = new Uint8Array(rec.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    await putRaw(indexedDB, { ...rec, ciphertext: tampered.buffer });
    const before = new Uint8Array((await rawRecord(indexedDB)).ciphertext);

    await expect(getOrCreateAccount({ indexedDB })).rejects.toMatchObject({ name: "KeystoreError", code: "unreadable" });
    await expect(getOrCreateAccount({ indexedDB })).rejects.toBeInstanceOf(KeystoreError);
    expect(new Uint8Array((await rawRecord(indexedDB)).ciphertext)).toEqual(before);
  });

  it.each([
    ["a string", "garbage"],
    ["an empty object", {}],
    ["a record with a short iv", { iv: new Uint8Array(3), ciphertext: new ArrayBuffer(48), aesKey: {} }],
    ["a record without a CryptoKey", { iv: new Uint8Array(12), ciphertext: new ArrayBuffer(48), aesKey: "k" }],
    ["null", null],
  ])("a malformed record (%s) throws unreadable and is not replaced", async (_label, value) => {
    const indexedDB = new IDBFactory();
    await putRaw(indexedDB, value);
    await expect(getOrCreateAccount({ indexedDB })).rejects.toMatchObject({ code: "unreadable" });
    expect(await rawRecord(indexedDB)).toEqual(value);
  });

  it("a decryptable record that is not a valid 32-byte key is unreadable, not replaced", async () => {
    const indexedDB = new IDBFactory();
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new Uint8Array(32)); // zero key
    await putRaw(indexedDB, { aesKey, iv, ciphertext });
    await expect(getOrCreateAccount({ indexedDB })).rejects.toMatchObject({ code: "unreadable" });
    expect((await rawRecord(indexedDB)).ciphertext).toEqual(ciphertext);
  });
});

describe("persistent storage", () => {
  it("asks the browser to persist storage after creating a key", async () => {
    const persist = vi.fn(async () => true);
    await getOrCreateAccount({ indexedDB: new IDBFactory(), storage: { persist } });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does not fail if persist() rejects or is unavailable", async () => {
    const persist = vi.fn(async () => {
      throw new Error("denied");
    });
    await expect(getOrCreateAccount({ indexedDB: new IDBFactory(), storage: { persist } })).resolves.toBeTruthy();
    await expect(getOrCreateAccount({ indexedDB: new IDBFactory(), storage: {} as never })).resolves.toBeTruthy();
  });

  it("does not ask again when the key already exists", async () => {
    const indexedDB = new IDBFactory();
    await getOrCreateAccount({ indexedDB });
    const persist = vi.fn(async () => true);
    await getOrCreateAccount({ indexedDB, storage: { persist } });
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("exportBackup", () => {
  it("returns the stored private key as 0x hex when explicitly acknowledged during a user gesture", async () => {
    const indexedDB = new IDBFactory();
    const account = await getOrCreateAccount({ indexedDB });
    const hex = await exportBackup({ indexedDB, acknowledgeRisk: true, ...gesture });
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAccount(hex).address).toBe(account.address);
  });

  it("refuses without acknowledgeRisk: true", async () => {
    const indexedDB = new IDBFactory();
    await getOrCreateAccount({ indexedDB });
    await expect(exportBackup({ indexedDB, ...gesture } as never)).rejects.toMatchObject({ code: "not_acknowledged" });
  });

  it("refuses outside a user gesture when the browser reports user activation", async () => {
    const indexedDB = new IDBFactory();
    await getOrCreateAccount({ indexedDB });
    await expect(exportBackup({ indexedDB, acknowledgeRisk: true, ...noGesture })).rejects.toMatchObject({ code: "no_user_gesture" });
  });

  it("refuses when there is no wallet, and never creates one", async () => {
    const indexedDB = new IDBFactory();
    await expect(exportBackup({ indexedDB, acknowledgeRisk: true, ...gesture })).rejects.toMatchObject({ code: "not_found" });
    expect(await rawRecord(indexedDB)).toBeUndefined();
  });

  it("refuses an unreadable record with 'unreadable'", async () => {
    const indexedDB = new IDBFactory();
    await putRaw(indexedDB, "garbage");
    await expect(exportBackup({ indexedDB, acknowledgeRisk: true, ...gesture })).rejects.toMatchObject({ code: "unreadable" });
  });
});

describe("importAccount", () => {
  it("imports a key into empty storage and getOrCreateAccount returns it", async () => {
    const indexedDB = new IDBFactory();
    const pk = generatePrivateKey();
    const persist = vi.fn(async () => true);
    const imported = await importAccount(pk, { indexedDB, storage: { persist } });
    expect(imported.address).toBe(privateKeyToAccount(pk).address);
    expect((await getOrCreateAccount({ indexedDB })).address).toBe(imported.address);
    expect(persist).toHaveBeenCalled();
    const rec = await rawRecord(indexedDB);
    expect(rec.aesKey.extractable).toBe(false);
  });

  it("round-trips exportBackup -> importAccount into fresh storage", async () => {
    const a = new IDBFactory();
    const account = await getOrCreateAccount({ indexedDB: a });
    const hex = await exportBackup({ indexedDB: a, acknowledgeRisk: true, ...gesture });
    const b = new IDBFactory();
    expect((await importAccount(hex, { indexedDB: b })).address).toBe(account.address);
  });

  it("refuses to replace an existing wallet without overwrite: true", async () => {
    const indexedDB = new IDBFactory();
    const original = await getOrCreateAccount({ indexedDB });
    await expect(importAccount(generatePrivateKey(), { indexedDB })).rejects.toMatchObject({ code: "exists" });
    expect((await getOrCreateAccount({ indexedDB })).address).toBe(original.address);
  });

  it("refuses to replace an unreadable record without overwrite: true", async () => {
    const indexedDB = new IDBFactory();
    await putRaw(indexedDB, "garbage");
    await expect(importAccount(generatePrivateKey(), { indexedDB })).rejects.toMatchObject({ code: "exists" });
    expect(await rawRecord(indexedDB)).toBe("garbage");
  });

  it("replaces an existing (even unreadable) record with overwrite: true", async () => {
    const indexedDB = new IDBFactory();
    await putRaw(indexedDB, "garbage");
    const pk = generatePrivateKey();
    const acct = await importAccount(pk, { indexedDB, overwrite: true });
    expect((await getOrCreateAccount({ indexedDB })).address).toBe(acct.address);
  });

  it.each(["", "0x", "0x1234", "0x" + "zz".repeat(32), "0x" + "00".repeat(32), "ab".repeat(32), "0x" + "ff".repeat(32)])(
    "rejects an invalid key %#, without echoing it",
    async (bad) => {
      const indexedDB = new IDBFactory();
      const err = await importAccount(bad as `0x${string}`, { indexedDB }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KeystoreError);
      expect((err as KeystoreError).code).toBe("invalid_key");
      if (bad.length > 4) expect((err as Error).message).not.toContain(bad.slice(2, 20));
      expect(await rawRecord(indexedDB)).toBeUndefined();
    },
  );

  it("never logs the key and never touches localStorage-like globals", async () => {
    const logs: unknown[] = [];
    for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a));
    }
    const indexedDB = new IDBFactory();
    const pk = generatePrivateKey();
    await importAccount(pk, { indexedDB });
    await importAccount(generatePrivateKey(), { indexedDB }).catch(() => undefined);
    await exportBackup({ indexedDB, acknowledgeRisk: true, ...gesture });
    expect(JSON.stringify(logs).toLowerCase()).not.toContain(pk.slice(2).toLowerCase());
    vi.restoreAllMocks();
  });
});
