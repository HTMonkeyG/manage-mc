const fsp = require("fs/promises")
  , path = require("path");

const NBT = require("parsenbt-js");

const Fsx = require("./fsx");

// A level.dat is an 8 byte header followed by a little-endian NBT payload.
const HEADER_SIZE = 8;

// Game type values used by the client, indexed by the GameType tag.
const GAME_MODES = ["survival", "creative", "adventure", "spectator"];

class LevelDat {
  /**
   * Read the metadata of a world folder.
   *
   * Never throws: a world with a missing or unreadable level.dat still has to
   * appear in the list, so failures degrade to nulls.
   * @param {string} worldDir - Path of the world folder.
   * @returns {Promise<object|null>} Parsed metadata, or null when unreadable.
   */
  static async readMeta(worldDir) {
    var fromDat = await LevelDat.read(path.join(worldDir, "level.dat"));

    // levelname.txt is a plain sibling of level.dat holding the same value.
    var fromTxt = await Fsx.readTextLenient(path.join(worldDir, "levelname.txt"));

    if (fromDat === null && fromTxt === null)
      return null

    var meta = fromDat || { headerVersion: null, levelName: null };

    if (fromTxt !== null)
      meta.levelNameFile = fromTxt.trim();
    else
      meta.levelNameFile = null;

    // The name file is authoritative for display when level.dat is unreadable.
    if (!meta.levelName && meta.levelNameFile)
      meta.levelName = meta.levelNameFile;

    return meta
  }

  /**
   * Read and parse a level.dat file.
   * @param {string} file - Path of the level.dat file.
   * @returns {Promise<object|null>} Parsed metadata, or null when unreadable.
   */
  static async read(file) {
    var buf;

    try {
      buf = await fsp.readFile(file);
    } catch (e) {
      return null
    }

    return LevelDat.parse(buf)
  }

  /**
   * Parse a level.dat buffer.
   * @param {Buffer} buf - Raw file contents.
   * @returns {object|null} Parsed metadata, or null when malformed.
   */
  static parse(buf) {
    if (!buf || buf.length < HEADER_SIZE)
      return null

    var version = buf.readUInt32LE(0)
      , payloadLen = buf.readUInt32LE(4);

    // The payload must fit inside the file. The header version itself is only
    // reported, never asserted: it is 10 for level.dat and level.dat_old but 9
    // for temp_level.dat, all of which are valid inputs.
    if (payloadLen === 0 || payloadLen > buf.length - HEADER_SIZE)
      return null

    var root;

    try {
      // parsenbt-js only honours little-endian through the options object; the
      // boolean form shown in its README is ignored and yields big-endian.
      root = NBT.Reader(buf.subarray(HEADER_SIZE), { littleEndian: true })["obj>"];
    } catch (e) {
      return null
    }

    if (!root || typeof root !== "object")
      return null

    var gameType = LevelDat.num(root["i32>GameType"]);

    return {
      headerVersion: version,
      levelName: LevelDat.str(root["str>LevelName"]),
      lastPlayed: LevelDat.i64(root["i64>LastPlayed"]),
      time: LevelDat.i64(root["i64>Time"]),
      gameType: gameType,
      gameMode: gameType === null ? null : GAME_MODES[gameType] || `unknown(${gameType})`,
      randomSeed: LevelDat.i64Text(root["i64>RandomSeed"]),
      storageVersion: LevelDat.num(root["i32>StorageVersion"]),
      worldVersion: LevelDat.num(root["i32>WorldVersion"]),
      networkVersion: LevelDat.num(root["i32>NetworkVersion"]),
      inventoryVersion: LevelDat.str(root["str>InventoryVersion"]),
      lastOpenedWithVersion: LevelDat.versionList(root["lst>lastOpenedWithVersion"]),
      isHardcore: Boolean(LevelDat.num(root["i08>IsHardcore"])),
      encryptFlag: Boolean(LevelDat.num(root["i08>neteaseEncryptFlag"])),
      keyCount: Object.keys(root).length
    }
  }

  /**
   * Convert a TAG_Long into a JavaScript number.
   *
   * parsenbt-js yields {low, high} pairs rather than BigInt unless asked
   * otherwise. Values beyond Number.MAX_SAFE_INTEGER lose precision here; use
   * i64Text() when exactness matters.
   * @param {object|bigint|number} value - Encoded long.
   * @returns {number|null}
   */
  static i64(value) {
    if (value === undefined || value === null)
      return null

    if (typeof value === "bigint")
      return Number(value)

    if (typeof value === "number")
      return value

    if (typeof value === "object" && "low" in value && "high" in value)
      return value.high * 4294967296 + (value.low >>> 0)

    return null
  }

  /**
   * Convert a TAG_Long into an exact decimal string.
   * @param {object|bigint|number} value - Encoded long.
   * @returns {string|null}
   */
  static i64Text(value) {
    if (value === undefined || value === null)
      return null

    if (typeof value === "bigint")
      return value.toString()

    if (typeof value === "number")
      return String(value)

    if (typeof value === "object" && "low" in value && "high" in value) {
      // Rebuild the signed 64 bit value without losing the low word.
      var big = (BigInt(value.high) << 32n) | BigInt(value.low >>> 0);

      if (big >= 9223372036854775808n)
        big -= 18446744073709551616n;

      return big.toString()
    }

    return null
  }

  /**
   * Read a numeric tag.
   * @param {any} value - Raw tag value.
   * @returns {number|null}
   */
  static num(value) {
    if (typeof value === "number")
      return value
    if (typeof value === "bigint")
      return Number(value)
    return null
  }

  /**
   * Read a string tag.
   * @param {any} value - Raw tag value.
   * @returns {string|null}
   */
  static str(value) {
    return typeof value === "string" ? value : null
  }

  /**
   * Render a typed version list such as ["i32",1,21,120,0,0].
   *
   * Element 0 of a parsenbt-js list is the element type name, so it is skipped
   * the same way the project template does.
   * @param {any[]} value - Raw list tag.
   * @returns {string|null} Dotted version, or null when unusable.
   */
  static versionList(value) {
    if (!Array.isArray(value) || value.length < 2)
      return null

    var parts = value.slice(1).map(v => String(v));

    // Trailing zeros carry no information in a version string.
    while (parts.length > 2 && parts[parts.length - 1] === "0")
      parts.pop();

    return parts.join(".")
  }
}

module.exports = LevelDat;
