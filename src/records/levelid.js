const fs = require("fs")
  , crypto = require("crypto");

const Fsx = require("../os/fsx");

// Local worlds use base64 of 8 random bytes, which encodes to 12 characters.
const LOCAL_ID_BYTES = 8;

// Base64 can emit "/" and "+", but "/" is not a legal path segment, so a minted
// id is validated rather than assumed usable.
const SAFE_ID_RE = /^[A-Za-z0-9+=\-_]+$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class LevelId {
  /**
   * Test whether an id can be used as a directory name and file name stem.
   *
   * The game accepts arbitrary ids, not just base64 or UUIDs: the sample ships
   * a world called "TESTAAA". Only ids that are unsafe as a path segment are
   * rejected, so an unusual but legal id keeps its identity.
   * @param {string} id - Candidate level id.
   * @returns {boolean}
   */
  static isSafe(id) {
    return typeof id === "string"
      && id.length > 0
      && id.length <= 128
      && SAFE_ID_RE.test(id)
      && id !== "."
      && id !== ".."
  }

  /**
   * Test whether an id is a UUID, used by marketplace and rental worlds.
   * @param {string} id - Candidate level id.
   * @returns {boolean}
   */
  static isUuid(id) {
    return typeof id === "string" && UUID_RE.test(id)
  }

  /**
   * Test whether an id is the base64 form used by locally created worlds.
   * @param {string} id - Candidate level id.
   * @returns {boolean}
   */
  static isLocal(id) {
    if (typeof id !== "string" || id.length !== 12 || !SAFE_ID_RE.test(id))
      return false

    try {
      var buf = Buffer.from(id, "base64");
      return buf.length === LOCAL_ID_BYTES && buf.toString("base64") === id
    } catch (e) {
      return false
    }
  }

  /**
   * Classify an id for display.
   * @param {string} id - Level id.
   * @returns {"uuid"|"local"|"other"}
   */
  static describe(id) {
    if (LevelId.isUuid(id))
      return "uuid"
    if (LevelId.isLocal(id))
      return "local"
    return "other"
  }

  /**
   * Mint a new level id that collides with nothing on disk.
   * @param {GameLayout} layout - Target layout.
   * @param {Set<string>} taken - Ids already allocated during this run.
   * @returns {string} A 12 character base64 id, e.g. "iSRK+kcWllU=".
   */
  static mint(layout, taken) {
    var used = taken || new Set();

    for (var attempt = 0; attempt < 1000; attempt++) {
      var id = crypto.randomBytes(LOCAL_ID_BYTES).toString("base64");

      // Roughly one in seven base64 draws contains a "/", which cannot be a
      // path segment, so a rejected draw is expected rather than exceptional.
      if (!SAFE_ID_RE.test(id))
        continue

      if (used.has(id))
        continue

      // Probe the two deterministic namespaces directly, so the result stays
      // correct even if the directory changed after the list was rendered.
      if (fs.existsSync(layout.worldDir(id)))
        continue

      if (fs.existsSync(layout.recordFile(id)))
        continue

      used.add(id);
      return id
    }

    throw new Error("Unable to allocate an unused level id")
  }

  /**
   * Collect every id already claimed by a folder or a record.
   * @param {GameLayout} layout - Target layout.
   * @returns {Promise<Set<string>>}
   */
  static async collectTaken(layout) {
    var taken = new Set();

    for (var name of await Fsx.listDirs(layout.minecraftWorlds))
      taken.add(name);

    for (var entry of await Fsx.readdir(layout.records))
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        taken.add(entry.name.slice(0, -5));

    return taken
  }

  /**
   * Probe every namespace an id can occupy in the target tree.
   *
   * The per-user folders must be checked as well as the folder and the record:
   * the sample has hundreds of orphan user folders, and importing over one
   * would silently re-attach stale per-user data.
   * @param {GameLayout} layout - Target layout.
   * @param {string} id - Level id to probe.
   * @param {string[]} uids - Account ids to probe.
   * @returns {Promise<{folder: boolean, record: boolean, userFolders: string[], any: boolean}>}
   */
  static async probeCollision(layout, id, uids) {
    var folder = await Fsx.exists(layout.worldDir(id))
      , record = await Fsx.exists(layout.recordFile(id))
      , userFolders = [];

    for (var uid of uids || [])
      if (await Fsx.exists(layout.userWorldDir(uid, id)))
        userFolders.push(uid);

    return {
      folder: folder,
      record: record,
      userFolders: userFolders,
      any: folder || record || userFolders.length > 0
    }
  }
}

module.exports = LevelId;
