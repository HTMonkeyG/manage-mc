const path = require("path");

const Fsx = require("../os/fsx");
const LevelDat = require("../os/leveldat");
const WorldIntegrity = require("./integrity");
const WorldRecord = require("./record");

// Sort order for the world list: things that work first, things that need
// attention last.
const STATE_ORDER = {
  registered: 0,
  unregistered: 1,
  online: 2,
  dangling: 3,
  error: 4
};

// How the world list may be ordered.
const SORTS = ["default", "time", "name"];

class WorldRegistry {
  /**
   * Build the world list by outer joining the folder set with the record set.
   *
   * The registry is authoritative for visibility and the folder set is
   * authoritative for data, so neither side alone is the world list: the sample
   * holds 25 records against a single folder.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {object} [opts] - Options.
   * @param {boolean} [opts.withMeta] - Also read level.dat for each world, which is
   *   what supplies a real last played time rather than a record timestamp.
   * @param {"default"|"time"|"name"} [opts.sort] - Ordering, defaults to "default".
   * @returns {Promise<object[]>} World entries, sorted for display.
   */
  static async build(layout, opts) {
    var options = opts || {}
      , withMeta = Boolean(options.withMeta)
      , folders = await Fsx.listDirs(layout.minecraftWorlds)
      , records = await WorldRecord.list(layout)
      , userIndex = await WorldRegistry.indexUsers(layout)
      , byId = new Map();

    for (var name of folders)
      byId.set(name, {
        levelId: name,
        worldDir: layout.worldDir(name),
        record: null,
        recordFile: null,
        recordError: null
      });

    for (var found of records) {
      var item = byId.get(found.levelId);

      if (!item) {
        item = {
          levelId: found.levelId,
          worldDir: null,
          record: null,
          recordFile: null,
          recordError: null
        };
        byId.set(found.levelId, item);
      }

      item.record = found.record;
      item.recordFile = found.file;
      item.recordError = found.error;
    }

    var out = [];

    for (var entry of byId.values()) {
      entry.state = WorldRegistry.stateOf(entry);
      entry.usersPresent = userIndex.get(entry.levelId) || {};
      entry.anomalies = WorldRegistry.anomaliesOf(entry);
      entry.size = null;
      entry.levelMeta = null;
      entry.integrity = null;

      if (withMeta && entry.worldDir)
        entry.levelMeta = await LevelDat.readMeta(entry.worldDir);

      entry.displayName = WorldRegistry.displayNameOf(entry);
      entry.userIds = WorldRecord.userIds(entry.record);
      entry.lastPlayed = WorldRegistry.lastPlayedOf(entry);

      out.push(entry);
    }

    WorldRegistry.sortEntries(out, options.sort);

    return out
  }

  /**
   * Order entries in place.
   *
   * Exposed so the list can re-order the entries it already holds when the sort
   * setting changes, rather than going back to disk for values it already has.
   * @param {object[]} entries - Entries to reorder.
   * @param {string} [mode] - "default", "time" or "name".
   * @returns {object[]} The same array, reordered.
   */
  static sortEntries(entries, mode) {
    return entries.sort(WorldRegistry.comparator(mode))
  }

  /**
   * Read the last time a world was played.
   *
   * level.dat carries the real figure, so it wins whenever it has been read.
   * The record's account timestamps are the fallback: they mark when an account
   * was attached rather than when the world was played, so they are only a
   * lower bound.
   * @param {object} entry - World entry.
   * @returns {number|null} Unix seconds, or null when nothing dates the world.
   */
  static lastPlayedOf(entry) {
    if (entry.levelMeta && typeof entry.levelMeta.lastPlayed === "number" && entry.levelMeta.lastPlayed > 0)
      return entry.levelMeta.lastPlayed

    var stamps = []

    if (entry.record && entry.record.user_ids && typeof entry.record.user_ids === "object")
      for (var uid of Object.keys(entry.record.user_ids)) {
        var value = Number(entry.record.user_ids[uid]);

        if (Number.isFinite(value) && value > 0)
          stamps.push(value);
      }

    if (stamps.length === 0)
      return null

    return Math.max.apply(null, stamps)
  }

  /**
   * Check a world's files on demand.
   *
   * Kept out of build() for the same reason as measure(): the check reads the
   * folder, and the list should not wait for that before it can paint.
   * @param {object} entry - World entry.
   * @returns {Promise<object|null>} Integrity report, or null when there is no folder.
   */
  static async checkIntegrity(entry) {
    if (!entry.worldDir)
      return null

    entry.integrity = await WorldIntegrity.check(entry.worldDir);
    return entry.integrity
  }

  /**
   * Build the comparator for a sort mode.
   * @param {string} [mode] - "default", "time" or "name".
   * @returns {function(object, object): number}
   */
  static comparator(mode) {
    var byName = (a, b) => a.displayName.localeCompare(b.displayName, "zh-Hans-CN")
      , byState = (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state];

    if (mode === "name")
      return byName

    if (mode === "time") {
      // Newest first, and anything undated sinks to the bottom rather than
      // sorting as if it were from 1970.
      return (a, b) => {
        if (a.lastPlayed === null && b.lastPlayed === null)
          return byState(a, b) || byName(a, b)

        if (a.lastPlayed === null)
          return 1

        if (b.lastPlayed === null)
          return -1

        return b.lastPlayed - a.lastPlayed || byName(a, b)
      }
    }

    return (a, b) => byState(a, b) || byName(a, b)
  }

  /**
   * Test whether a sort mode is one this registry understands.
   * @param {string} mode - Candidate mode.
   * @returns {boolean}
   */
  static isSortMode(mode) {
    return SORTS.includes(mode)
  }

  /**
   * Derive the state of a world entry.
   * @param {object} entry - Partially filled entry.
   * @returns {"registered"|"unregistered"|"online"|"dangling"|"error"}
   */
  static stateOf(entry) {
    if (entry.recordError)
      return "error"

    if (entry.worldDir !== null && entry.record !== null)
      return "registered"

    if (entry.worldDir !== null)
      return "unregistered"

    // No folder: a local record is a ghost entry the game will show as broken,
    // while a non-local record is an ordinary marketplace or rental world.
    return WorldRecord.isLocal(entry.record) ? "dangling" : "online"
  }

  /**
   * Collect the inconsistencies worth surfacing for an entry.
   * @param {object} entry - Partially filled entry.
   * @returns {string[]}
   */
  static anomaliesOf(entry) {
    var out = [];

    if (entry.recordError)
      out.push(entry.recordError);

    if (!entry.record)
      return out

    if (typeof entry.record.level_id === "string" && entry.record.level_id !== entry.levelId)
      out.push(`record.level_id is "${entry.record.level_id}" while the file is named "${entry.levelId}"; the file name wins`);

    if (entry.worldDir !== null && typeof entry.record.path === "string") {
      var declared = path.posix.basename(String(entry.record.path).split("\\").join("/"));

      // A stale path is only interesting when the folder exists; a dangling
      // record legitimately points at a folder that is gone.
      if (declared !== entry.levelId)
        out.push(`record.path points at "${declared}" instead of this world`);
    }

    return out
  }

  /**
   * Choose the name shown for an entry.
   * @param {object} entry - Partially filled entry.
   * @returns {string}
   */
  static displayNameOf(entry) {
    var fromRecord = WorldRecord.displayName(entry.record);

    if (fromRecord)
      return fromRecord

    if (entry.levelMeta) {
      if (entry.levelMeta.levelName)
        return entry.levelMeta.levelName
      if (entry.levelMeta.levelNameFile)
        return entry.levelMeta.levelNameFile
    }

    return entry.levelId
  }

  /**
   * Index every per-user world folder by level id.
   *
   * Only leaf folders whose name is a level id are indexed, because a user
   * folder also holds unrelated state such as skin.txt and chat history.
   * @param {GameLayout} layout - Resolved game layout.
   * @returns {Promise<Map<string, object>>} Level id mapped to {uid: path}.
   */
  static async indexUsers(layout) {
    var index = new Map()
      , uids = await Fsx.listDirs(layout.users);

    for (var uid of uids) {
      var userDir = path.join(layout.users, uid);

      for (var name of await Fsx.listDirs(userDir)) {
        if (!index.has(name))
          index.set(name, {});

        index.get(name)[uid] = path.join(userDir, name);
      }

      await Fsx.yield();
    }

    return index
  }

  /**
   * Measure the size of a world folder on demand.
   *
   * Kept out of build() so the list can render immediately; a save manager is
   * usually pointed at folders far larger than the sample.
   * @param {object} entry - World entry.
   * @returns {Promise<{files: number, bytes: number}|null>}
   */
  static async measure(entry) {
    if (!entry.worldDir)
      return null

    var size = await Fsx.du(entry.worldDir);
    entry.size = size;
    return size
  }

  /**
   * Load the level.dat metadata of an entry on demand.
   * @param {object} entry - World entry.
   * @returns {Promise<object|null>}
   */
  static async loadMeta(entry) {
    if (!entry.worldDir)
      return null

    entry.levelMeta = await LevelDat.readMeta(entry.worldDir);
    return entry.levelMeta
  }

  /**
   * Count entries by state.
   * @param {object[]} entries - World entries.
   * @returns {object} Counts keyed by state.
   */
  static countByState(entries) {
    var counts = { registered: 0, unregistered: 0, online: 0, dangling: 0, error: 0 };

    for (var entry of entries)
      counts[entry.state] = (counts[entry.state] || 0) + 1;

    return counts
  }
}

module.exports = WorldRegistry;
