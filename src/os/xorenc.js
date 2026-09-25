const fsp = require("fs/promises")
  , path = require("path");

const Fsx = require("./fsx");

// An encrypted file begins with a 32 bit magic number, read big endian from the
// first four bytes. The client uses 0x801D3001; the alternate value is accepted
// because the reference tool checks for both.
const MAGIC = 0x801D3001;
const MAGIC_ALT = 0x901D3001;
const MAGIC_SIZE = 4;

// The key is always 8 bytes, and this ASCII string is the key the client itself
// uses, so a world encrypted by the client decrypts without any inference.
const KEY_LENGTH = 8;
const DEFAULT_KEY = Buffer.from("88329851", "ascii");

// A LevelDB table ends with this marker. Decrypting a table with the right key
// reproduces it, which is what proves a key rather than merely suggesting one.
const TABLE_MARKER = 0x57FB808B247547DBn;
const MARKER_SIZE = 8;

const MANIFEST_RE = /^MANIFEST-\d{6,}$/;
const TABLE_RE = /\.ldb$/i;

// Files the client encrypts. A ".log" is deliberately absent: the sample ships
// a plain one, and encrypting it would break the database. This is the fallback
// rule, used only when a package does not record the exact file list.
const CLIENT_ENCRYPTED_RE = /^(CURRENT|MANIFEST-\d{6,}|\d{6,}\.ldb)$/;

class XorEnc {
  /**
   * Test whether a buffer carries the encryption magic number.
   * @param {Buffer} buf - Buffer to test.
   * @returns {boolean}
   */
  static isEncrypted(buf) {
    if (!buf || buf.length < MAGIC_SIZE)
      return false

    var magic = buf.readUInt32BE(0);
    return magic === MAGIC || magic === MAGIC_ALT
  }

  /**
   * Test whether a db file name is one the client encrypts.
   * @param {string} name - File name inside db/.
   * @returns {boolean}
   */
  static isClientEncrypted(name) {
    return CLIENT_ENCRYPTED_RE.test(name)
  }

  /**
   * Apply the repeating key to a buffer.
   *
   * The period is always KEY_LENGTH, not the key's own length: the reference
   * tool encrypts with a fixed period of 8 and decrypts with the key length,
   * which only agree because the key is normalised to 8 bytes first.
   * @param {Buffer} buf - Buffer to transform.
   * @param {Buffer|string} key - Key to apply.
   * @returns {Buffer} Transformed copy, leaving the input untouched.
   */
  static xor(buf, key) {
    var k = XorEnc.normalizeKey(key)
      , out = Buffer.from(buf);

    for (var i = 0; i < out.length; i++)
      out[i] ^= k[i % KEY_LENGTH];

    return out
  }

  /**
   * Coerce a key to exactly KEY_LENGTH bytes.
   * @param {Buffer|string} key - Key material.
   * @returns {Buffer} An 8 byte key.
   */
  static normalizeKey(key) {
    var buf = Buffer.isBuffer(key) ? Buffer.from(key) : XorEnc.parseKey(key);

    if (buf.length === KEY_LENGTH)
      return buf

    // Longer keys keep their last 8 bytes and shorter ones are zero padded,
    // matching the reference tool.
    if (buf.length > KEY_LENGTH)
      return Buffer.from(buf.subarray(buf.length - KEY_LENGTH));

    var padded = Buffer.alloc(KEY_LENGTH);
    buf.copy(padded);
    return padded
  }

  /**
   * Read a key typed by a user.
   *
   * A "0x" prefix means hex; anything else is read as ASCII. Bare text that
   * happens to look like hex is treated as ASCII, because the client's own key
   * ("88329851") is ASCII and would otherwise be ambiguous. Stored keys are
   * always read back from their hex form, so this only affects typed input.
   * @param {string} text - Key text.
   * @returns {Buffer} Key material, possibly of any length.
   */
  static parseKey(text) {
    var trimmed = String(text === undefined || text === null ? "" : text).trim();

    if (!trimmed.length)
      return Buffer.alloc(0)

    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      var hex = trimmed.slice(2);
      return /^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0
        ? Buffer.from(hex, "hex")
        : Buffer.alloc(0)
    }

    return Buffer.from(trimmed, "ascii")
  }

  /**
   * Describe a key for display and for storing in a manifest.
   * @param {Buffer|string} key - Key to describe.
   * @returns {{hex: string, ascii: string}} Both readable forms.
   */
  static describeKey(key) {
    var k = XorEnc.normalizeKey(key);

    return { hex: k.toString("hex"), ascii: k.toString("ascii") }
  }

  /**
   * Rebuild a key from a stored manifest entry.
   * @param {object} stored - Manifest xor record.
   * @returns {Buffer|null} The key, or null when the record has none.
   */
  static keyFromRecord(stored) {
    if (!stored)
      return null

    if (typeof stored.keyHex === "string" && /^[0-9a-fA-F]{16}$/.test(stored.keyHex))
      return Buffer.from(stored.keyHex, "hex")

    if (typeof stored.keyAscii === "string" && stored.keyAscii.length > 0)
      return XorEnc.normalizeKey(Buffer.from(stored.keyAscii, "ascii"))

    return null
  }

  /**
   * Strip the magic and undo the key.
   * @param {Buffer} buf - Encrypted buffer.
   * @param {Buffer|string} key - Key to apply.
   * @returns {Buffer|null} Plain buffer, or null when the input is not encrypted.
   */
  static decrypt(buf, key) {
    if (!XorEnc.isEncrypted(buf))
      return null

    return XorEnc.xor(buf.subarray(MAGIC_SIZE), key)
  }

  /**
   * Apply the key and prepend the magic.
   * @param {Buffer} buf - Plain buffer.
   * @param {Buffer|string} [key] - Key to apply, defaults to the client key.
   * @returns {Buffer} Encrypted buffer.
   */
  static encrypt(buf, key) {
    var body = XorEnc.xor(buf, key === undefined ? DEFAULT_KEY : key)
      , out = Buffer.alloc(body.length + MAGIC_SIZE);

    out.writeUInt32BE(MAGIC, 0);
    body.copy(out, MAGIC_SIZE);

    return out
  }

  /**
   * Read only the first bytes of a file.
   * @param {string} file - File to peek at.
   * @param {number} length - How many bytes to read.
   * @returns {Promise<Buffer|null>} The head, or null when unreadable.
   */
  static async readHead(file, length) {
    var handle = null;

    try {
      handle = await fsp.open(file, "r");

      var buf = Buffer.alloc(length)
        , { bytesRead } = await handle.read(buf, 0, length, 0);

      return bytesRead === length ? buf : null
    } catch (e) {
      return null
    } finally {
      if (handle)
        await handle.close();
    }
  }

  /**
   * Report which files in a db folder are encrypted.
   *
   * Only the magic number is read, so this stays cheap enough to run for a
   * detail view without reading multi-megabyte tables.
   * @param {string} dbDir - Path of the db folder.
   * @returns {Promise<object>} Inspection result.
   */
  static async inspect(dbDir) {
    var entries = await Fsx.readdir(dbDir)
      , encrypted = []
      , plain = []
      , manifest = null;

    for (var entry of entries) {
      if (!entry.isFile())
        continue

      if (MANIFEST_RE.test(entry.name))
        manifest = entry.name;

      var head = await XorEnc.readHead(path.join(dbDir, entry.name), MAGIC_SIZE);

      if (head === null)
        continue

      if (XorEnc.isEncrypted(head))
        encrypted.push(entry.name);
      else
        plain.push(entry.name);
    }

    return {
      manifest: manifest,
      encrypted: encrypted,
      plain: plain,
      total: encrypted.length + plain.length,
      isEncrypted: encrypted.length > 0,
      isMixed: encrypted.length > 0 && plain.length > 0
    }
  }

  /**
   * Infer the key from a db folder.
   *
   * A LevelDB CURRENT file holds the manifest's file name, and file names
   * themselves are never encrypted. That gives a known plaintext pair, so
   * XOR-ing the manifest name against the encrypted CURRENT recovers the key.
   * The guess is confirmed twice: the key must repeat with the expected period
   * across the whole file, and decrypting a table must reproduce its trailing
   * marker.
   * @param {string} dbDir - Path of the db folder.
   * @returns {Promise<{key: Buffer, manifest: string, verified: boolean|null}|null>}
   */
  static async inferKey(dbDir) {
    var entries = await Fsx.readdir(dbDir)
      , manifest = null;

    for (var entry of entries)
      if (entry.isFile() && MANIFEST_RE.test(entry.name)) {
        manifest = entry.name;
        break
      }

    if (!manifest)
      return null

    // Read as bytes, never as text: an encrypted CURRENT holds values above
    // 0x7F and a UTF-8 round trip would silently rewrite them.
    var currentBuf = await Fsx.readBufferLenient(path.join(dbDir, "CURRENT"));

    if (currentBuf === null || !XorEnc.isEncrypted(currentBuf))
      return null

    var known = Buffer.from(manifest + "\n", "ascii")
      , cipher = currentBuf.subarray(MAGIC_SIZE);

    if (known.length !== cipher.length || known.length < KEY_LENGTH)
      return null

    var derived = Buffer.alloc(known.length);

    for (var i = 0; i < known.length; i++)
      derived[i] = known[i] ^ cipher[i];

    // The key repeats, so every byte must agree with its counterpart one period
    // earlier. A wrong plaintext assumption fails this immediately.
    for (var i = KEY_LENGTH; i < derived.length; i++)
      if (derived[i] !== derived[i % KEY_LENGTH])
        return null

    var key = Buffer.from(derived.subarray(0, KEY_LENGTH))
      , verified = await XorEnc.verifyKey(dbDir, key, entries);

    return { key: key, manifest: manifest, verified: verified }
  }

  /**
   * Confirm a key by decrypting a table and checking its trailing marker.
   *
   * Only the smallest table is tried: the marker is 64 bits, so one match is
   * conclusive, and it keeps verification from reading every table twice.
   * @param {string} dbDir - Path of the db folder.
   * @param {Buffer} key - Key to confirm.
   * @param {import("fs").Dirent[]} entries - Directory entries of db/.
   * @returns {Promise<boolean|null>} True, false, or null when no table exists.
   */
  static async verifyKey(dbDir, key, entries) {
    var candidates = []
      , smallest = null;

    for (var entry of entries) {
      if (!entry.isFile() || !TABLE_RE.test(entry.name))
        continue

      var stat = await fsp.stat(path.join(dbDir, entry.name));

      if (smallest === null || stat.size < smallest.size)
        smallest = { name: entry.name, size: stat.size };
    }

    if (smallest === null)
      return null

    var buf = await fsp.readFile(path.join(dbDir, smallest.name));

    if (!XorEnc.isEncrypted(buf))
      return null

    var plain = XorEnc.decrypt(buf, key);

    if (!plain || plain.length < MARKER_SIZE)
      return false

    return plain.readBigUInt64BE(plain.length - MARKER_SIZE) === TABLE_MARKER
  }

  /**
   * Transform the files of a db folder in place.
   *
   * Decryption is driven by the magic number, so it touches exactly the files
   * that are really encrypted. Encryption follows the recorded file list when
   * there is one, falling back to the names the client encrypts, because a
   * plain ".log" that the client left alone must stay plain.
   * @param {string} dbDir - Path of the db folder.
   * @param {Buffer|string} key - Key to apply.
   * @param {"decrypt"|"encrypt"} mode - Direction.
   * @param {object} [opts] - Options.
   * @param {string[]} [opts.files] - Exact files to encrypt, for encrypt mode.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @returns {Promise<{changed: string[], skipped: string[], bytes: number}>}
   */
  static async transform(dbDir, key, mode, opts) {
    var options = opts || {}
      , wanted = Array.isArray(options.files) ? new Set(options.files) : null
      , entries = await Fsx.readdir(dbDir)
      , files = entries.filter(e => e.isFile() && (mode === "decrypt" || XorEnc.shouldEncrypt(e.name, wanted)))
      , changed = []
      , skipped = []
      , bytes = 0;

    for (var index = 0; index < files.length; index++) {
      if (options.signal && options.signal.aborted)
        break

      var entry = files[index]
        , file = path.join(dbDir, entry.name);

      // Peek at the magic before reading the whole file, so a multi-megabyte
      // plain log is never pulled into memory just to be left alone.
      var alreadyEncrypted = XorEnc.isEncrypted(await XorEnc.readHead(file, MAGIC_SIZE));

      if (mode === "decrypt" && !alreadyEncrypted) {
        skipped.push(entry.name);
        continue
      }

      if (mode === "encrypt" && alreadyEncrypted) {
        skipped.push(entry.name);
        continue
      }

      var buf = await fsp.readFile(file)
        , out = mode === "decrypt" ? XorEnc.decrypt(buf, key) : XorEnc.encrypt(buf, key);

      if (!out) {
        skipped.push(entry.name);
        continue
      }

      await Fsx.atomicWriteBuffer(file, out);
      changed.push(entry.name);
      bytes += out.length;

      if (options.onProgress)
        options.onProgress({
          files: index + 1,
          filesTotal: files.length,
          bytes: bytes,
          bytesTotal: 0,
          currentPath: entry.name,
          elapsedMs: 0,
          etaMs: 0
        });
    }

    return { changed: changed, skipped: skipped, bytes: bytes }
  }

  /**
   * Decide whether a db file should be encrypted.
   * @param {string} name - File name inside db/.
   * @param {Set<string>} [wanted] - Exact file list recorded at export time.
   * @returns {boolean}
   */
  static shouldEncrypt(name, wanted) {
    if (wanted)
      return wanted.has(name)

    return XorEnc.isClientEncrypted(name)
  }

  /**
   * Decrypt a db folder, inferring the key when one is not supplied.
   * @param {string} dbDir - Path of the db folder.
   * @param {object} [opts] - Options.
   * @param {Buffer|string} [opts.key] - Explicit key, otherwise inferred.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @returns {Promise<object>} Decryption record for a manifest, or a failure description.
   */
  static async decryptDir(dbDir, opts) {
    var options = opts || {}
      , view = await XorEnc.inspect(dbDir);

    if (!view.isEncrypted)
      return { encrypted: false, decrypted: false, files: [] }

    var inferred = null
      , key = options.key ? XorEnc.normalizeKey(options.key) : null
      , verified = null;

    if (!key) {
      inferred = await XorEnc.inferKey(dbDir);

      if (!inferred)
        return {
          encrypted: true,
          decrypted: false,
          files: view.encrypted,
          error: "the encryption key could not be inferred; no MANIFEST file or an unexpected CURRENT file"
        }

      key = inferred.key;
      verified = inferred.verified;
    }

    var result = await XorEnc.transform(dbDir, key, "decrypt", {
      signal: options.signal,
      onProgress: options.onProgress
    });

    return {
      encrypted: true,
      decrypted: result.changed.length > 0,
      inferred: inferred !== null,
      verified: verified,
      keyHex: key.toString("hex"),
      keyAscii: key.toString("ascii"),
      files: result.changed,
      skipped: result.skipped,
      bytes: result.bytes
    }
  }

  /**
   * Encrypt a db folder with the client's own key.
   * @param {string} dbDir - Path of the db folder.
   * @param {object} [opts] - Options.
   * @param {Buffer|string} [opts.key] - Explicit key, defaults to the client key.
   * @param {string[]} [opts.files] - Exact files to encrypt.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @returns {Promise<object>} Encryption record.
   */
  static async encryptDir(dbDir, opts) {
    var options = opts || {}
      , key = options.key ? XorEnc.normalizeKey(options.key) : DEFAULT_KEY
      , result = await XorEnc.transform(dbDir, key, "encrypt", {
          files: options.files,
          signal: options.signal,
          onProgress: options.onProgress
        });

    return {
      encrypted: result.changed.length > 0,
      keyHex: key.toString("hex"),
      keyAscii: key.toString("ascii"),
      files: result.changed,
      skipped: result.skipped,
      bytes: result.bytes
    }
  }
}

module.exports = XorEnc;
