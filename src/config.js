const os = require("os")
  , path = require("path");

const Fsx = require("./os/fsx");

// Settings live beside the user's home directory rather than inside the game
// tree, so they survive a game reinstall or a moved data folder.
const CONFIG_FILE = ".manage-mc.json";

// Shapes returned by load(). Every consumer may assume these keys exist.
const DEFAULTS = {
  version: 1,
  gameRoot: null,
  rootSpelling: null,
  lastImportPath: null,
  lastExportDir: null,
  export: {
    format: "folder",
    includeUsers: true,
    includeOrphanUsers: false,
    // Decrypt the client's XOR encrypted database into the package, recording
    // the key so an import can put the encryption back.
    decryptWorlds: true
  },
  import: {
    onCollision: "copy",
    synthesizeRecord: true
  },
  ui: {
    confirmDestructive: true,
    // How the world list is ordered: "default" groups by state, "time" is
    // newest played first, "name" is purely alphabetical.
    worldSort: "default"
  }
};

class Config {
  /**
   * Absolute path of the settings file.
   * @returns {string}
   */
  static filePath() {
    return path.join(os.homedir(), CONFIG_FILE)
  }

  /**
   * Build a fresh copy of the default settings.
   *
   * A copy is returned rather than the constant itself, so a caller mutating
   * the result cannot corrupt the defaults for the rest of the process.
   * @returns {object}
   */
  static defaults() {
    return JSON.parse(JSON.stringify(DEFAULTS))
  }

  /**
   * Load settings, falling back to the defaults.
   *
   * Never throws: a missing, unreadable or corrupt settings file must not stop
   * the application from starting.
   * @returns {Promise<object>} Effective settings.
   */
  static async load() {
    var parsed = null;

    try {
      parsed = await Fsx.readJsonLenient(Config.filePath());
    } catch (e) {
      parsed = null;
    }

    if (parsed === null || typeof parsed !== "object")
      parsed = {};

    return Config.merge(Config.defaults(), parsed)
  }

  /**
   * Merge a patch into the settings file and write it back.
   * @param {object} patch - Settings to merge.
   * @returns {Promise<object>} Effective settings after the write.
   */
  static async save(patch) {
    var current = null;

    try {
      current = await Fsx.readJsonLenient(Config.filePath());
    } catch (e) {
      current = null;
    }

    if (current === null || typeof current !== "object")
      current = {};

    // Merge over the parsed original rather than the defaults, so keys written
    // by a newer version survive a write from an older one.
    var merged = Config.merge(current, patch);
    await Fsx.atomicWriteJson(Config.filePath(), merged);

    return Config.merge(Config.defaults(), merged)
  }

  /**
   * Deep merge plain objects.
   *
   * Nested plain objects are merged recursively; arrays and scalars are
   * replaced wholesale.
   * @param {object} base - Base object.
   * @param {object} patch - Values to apply.
   * @returns {object} Merged copy, leaving both inputs untouched.
   */
  static merge(base, patch) {
    var out = Object.assign({}, base);

    for (var key of Object.keys(patch || {})) {
      var value = patch[key]
        , existing = out[key];

      if (Config.isPlainObject(value) && Config.isPlainObject(existing))
        out[key] = Config.merge(existing, value);
      else
        out[key] = value;
    }

    return out
  }

  /**
   * Test whether a value is a plain object.
   * @param {any} value - Value to test.
   * @returns {boolean}
   */
  static isPlainObject(value) {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
  }
}

module.exports = Config;
