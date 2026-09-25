const path = require("path");

const Fsx = require("./fsx");

// The retail client ships a misspelled "storge" folder while the project
// documentation says "storage", so both spellings are probed. "storge" is
// listed first because it is the spelling observed on disk.
const STORAGE_NAMES = ["storge", "storage"];

// Spelling used when neither candidate exists and the tree must be created.
const DEFAULT_STORAGE_NAME = "storge";

class GameLayout {
  /**
   * Resolve the on-disk layout of a game data root.
   * @param {string} root - Path of the game data root.
   * @returns {Promise<GameLayout>} Resolved layout.
   */
  static async resolve(root) {
    var resolved = path.resolve(root);

    if (!(await Fsx.existsDir(resolved)))
      throw new Error(`Game data root does not exist: ${resolved}`);

    var entries = await Fsx.readdir(resolved)
      , warnings = []
      , worldsName = GameLayout.findDir(entries, "minecraftworlds")
      , candidates = STORAGE_NAMES
          .map(name => GameLayout.findDir(entries, name))
          .filter(name => name !== null);

    if (worldsName === null)
      warnings.push("minecraftWorlds is missing and will be created on import");

    var storageName = await GameLayout.pickStorage(resolved, candidates, warnings);

    return new GameLayout(resolved, {
      minecraftWorlds: path.join(resolved, worldsName || "minecraftWorlds"),
      storage: path.join(resolved, storageName || DEFAULT_STORAGE_NAME),
      spelling: (storageName || DEFAULT_STORAGE_NAME).toLowerCase(),
      warnings: warnings
    })
  }

  /**
   * Find a directory by case-insensitive name.
   * @param {import("fs").Dirent[]} entries - Directory entries to search.
   * @param {string} lowerName - Lowercase name to match.
   * @returns {string|null} Real on-disk name, or null when absent.
   */
  static findDir(entries, lowerName) {
    var hit = entries.find(e => e.isDirectory() && e.name.toLowerCase() === lowerName);
    return hit ? hit.name : null
  }

  /**
   * Choose between competing storage spellings.
   * @param {string} root - Game data root.
   * @param {string[]} candidates - On-disk spelling candidates.
   * @param {string[]} warnings - Warning sink.
   * @returns {Promise<string|null>} Chosen name, or null when none exists.
   */
  static async pickStorage(root, candidates, warnings) {
    if (candidates.length === 0)
      return null

    if (candidates.length === 1)
      return candidates[0]

    warnings.push(`Both ${candidates.join(" and ")} exist; preferring the one holding world records`);

    var best = candidates[0]
      , bestScore = -1;

    // A directory actually holding world records wins over one that merely has
    // a stream folder; otherwise the first candidate stands.
    for (var name of candidates) {
      var base = path.join(root, name)
        , score = 0;

      if (await Fsx.existsDir(path.join(base, "stream", "resource_management", "world_records")))
        score = 2;
      else if (await Fsx.existsDir(path.join(base, "stream")))
        score = 1;

      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }

    return best
  }

  /**
   * Build a layout around a known storage directory.
   *
   * Used for sources that carry only a registry, where the storage folder is
   * the entry point rather than a child discovered under a game root.
   * @param {string} root - Directory to treat as the game root.
   * @param {string} storageDir - Path of the storage directory.
   * @returns {GameLayout}
   */
  static forStorage(root, storageDir) {
    var resolvedRoot = path.resolve(root)
      , resolvedStorage = path.resolve(storageDir);

    return new GameLayout(resolvedRoot, {
      minecraftWorlds: path.join(resolvedRoot, "minecraftWorlds"),
      storage: resolvedStorage,
      spelling: path.basename(resolvedStorage).toLowerCase(),
      warnings: []
    })
  }

  /**
   * Build a layout from an already resolved root.
   * @param {string} root - Absolute game data root.
   * @param {object} parts - Resolved parts.
   * @param {string} parts.minecraftWorlds - Path of the world database.
   * @param {string} parts.storage - Path of the storage root.
   * @param {string} parts.spelling - On-disk storage spelling.
   * @param {string[]} [parts.warnings] - Collected warnings.
   */
  constructor(root, parts) {
    this.root = root;

    // Forward-slash form of the root, used when writing a record's path field.
    this.rootPosix = Fsx.toPosix(root);

    this.minecraftWorlds = parts.minecraftWorlds;
    this.storage = parts.storage;
    this.spelling = parts.spelling;
    this.warnings = parts.warnings || [];

    this.stream = path.join(this.storage, "stream");
    this.resourceManagement = path.join(this.stream, "resource_management");
    this.records = path.join(this.resourceManagement, "world_records");
    this.users = path.join(this.stream, "users");
    this.lastUserIdFile = path.join(this.users, "last_user_id");
  }

  /**
   * Path of a world folder inside the world database.
   * @param {string} levelId - Level id of the world.
   * @returns {string}
   */
  worldDir(levelId) {
    return path.join(this.minecraftWorlds, levelId)
  }

  /**
   * Path of a world record file.
   * @param {string} levelId - Level id of the world.
   * @returns {string}
   */
  recordFile(levelId) {
    return path.join(this.records, levelId + ".json")
  }

  /**
   * Path of a per-user world folder.
   * @param {string} uid - Account id.
   * @param {string} levelId - Level id of the world.
   * @returns {string}
   */
  userWorldDir(uid, levelId) {
    return path.join(this.users, uid, levelId)
  }

  /**
   * Path of a per-user record file.
   * @param {string} uid - Account id.
   * @returns {string}
   */
  lastPlayDataFile(uid) {
    return path.join(this.users, uid, "last_play_data")
  }

  /**
   * Create the storage tree needed to register a world.
   * @returns {Promise<void>}
   */
  async ensureStorage() {
    await Fsx.mkdirp(this.records);
    await Fsx.mkdirp(this.users);
  }

  /**
   * Test whether a string may be used as a single path segment.
   * @param {string} name - Candidate segment.
   * @returns {boolean}
   */
  static isSafeSegment(name) {
    return typeof name === "string"
      && name.length > 0
      && name !== "."
      && name !== ".."
      && !name.includes("/")
      && !name.includes("\\")
      && !name.includes(":")
      && !name.includes("\u0000")
  }

  /**
   * Turn an arbitrary display name into a safe single path segment.
   * @param {string} name - Raw name, possibly carrying section-sign colour codes.
   * @param {number} [maxLength] - Maximum length, defaults to 100.
   * @returns {string} Sanitized segment, possibly empty.
   */
  static sanitizeSegment(name, maxLength) {
    var limit = maxLength === undefined ? 100 : maxLength
      , text = String(name === undefined || name === null ? "" : name)
          // Section-sign colour codes are presentation only.
          .replace(/§./g, "")
          .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
          .replace(/\s+/g, " ")
          .trim();

    text = GameLayout.trimEdges(text);

    if (text.length > limit)
      text = GameLayout.trimEdges(text.slice(0, limit));

    return text
  }

  /**
   * Strip trailing dots and spaces, which Windows rejects in a segment.
   * @param {string} text - Text to trim.
   * @returns {string}
   */
  static trimEdges(text) {
    return text.replace(/^[. ]+/, "").replace(/[. ]+$/, "")
  }
}

module.exports = GameLayout;
