const path = require("path");

const Fsx = require("../os/fsx");

// World records are single-line JSON in the sample, though some are pretty
// printed. Both parse, so the reader is indifferent and the writer
// standardises on the compact form.
const RECORD_SUFFIX = ".json";

class WorldRecord {
  /**
   * Read a single world record.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {string} levelId - Level id of the world.
   * @returns {Promise<object|null>} Parsed record, or null when absent.
   */
  static async read(layout, levelId) {
    return Fsx.readJsonLenient(layout.recordFile(levelId))
  }

  /**
   * List every record in the registry.
   *
   * A malformed record does not abort the listing: it is reported with an
   * error so the row can still be rendered.
   * @param {GameLayout} layout - Resolved game layout.
   * @returns {Promise<{levelId: string, file: string, record: object|null, error: string|null}[]>}
   */
  static async list(layout) {
    var entries = await Fsx.readdir(layout.records)
      , out = [];

    for (var entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(RECORD_SUFFIX))
        continue

      var file = path.join(layout.records, entry.name)
        , record = null
        , error = null;

      try {
        record = await Fsx.readJsonLenient(file);

        if (record === null)
          error = "record file is empty";
      } catch (e) {
        error = e.message;
      }

      out.push({
        levelId: entry.name.slice(0, -RECORD_SUFFIX.length),
        file: file,
        record: record,
        error: error
      });
    }

    return out
  }

  /**
   * Write a world record atomically.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {string} levelId - Level id of the world.
   * @param {object} record - Record to serialize.
   * @returns {Promise<void>}
   */
  static async write(layout, levelId, record) {
    await Fsx.atomicWriteText(layout.recordFile(levelId), JSON.stringify(record));
  }

  /**
   * Read the account ids a record claims.
   * @param {object|null} record - World record.
   * @returns {string[]} Account ids, in record order.
   */
  static userIds(record) {
    if (!record || typeof record.user_ids !== "object" || record.user_ids === null)
      return []

    return Object.keys(record.user_ids)
  }

  /**
   * Read the display name of a record.
   * @param {object|null} record - World record.
   * @returns {string|null}
   */
  static displayName(record) {
    if (!record)
      return null

    var name = record.name;
    return typeof name === "string" && name.length > 0 ? name : null
  }

  /**
   * Report whether a record describes a locally stored world.
   * @param {object|null} record - World record.
   * @returns {boolean}
   */
  static isLocal(record) {
    return Boolean(record && record.is_local)
  }

  /**
   * Report whether a record describes a copy.
   * @param {object|null} record - World record.
   * @returns {boolean}
   */
  static isCopy(record) {
    return Boolean(record && record.is_copy)
  }

  /**
   * Rebuild the value the record's path field should hold.
   *
   * The rule is reproduced from the sample rather than guessed: an absolute
   * path only exists for a local world that is not a copy, everything else
   * carries the bare level id.
   * @param {GameLayout} layout - Target layout.
   * @param {string} levelId - Level id of the world.
   * @param {boolean} isLocal - Value of the is_local field.
   * @param {boolean} isCopy - Value of the is_copy field.
   * @returns {string}
   */
  static pathFor(layout, levelId, isLocal, isCopy) {
    if (isLocal && !isCopy)
      return `${layout.rootPosix}/minecraftWorlds/${levelId}`
    return levelId
  }
}

module.exports = WorldRecord;
