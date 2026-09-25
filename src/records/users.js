const Fsx = require("../os/fsx");
const WorldRecord = require("./record");

// The client creates a literal folder named "None" for a signed-out account.
// It is a client artefact rather than a user, so it is never offered as a
// default account.
const PLACEHOLDER_UID = "None";

class UserFolders {
  /**
   * List the accounts the client already knows about on this machine.
   * @param {GameLayout} layout - Resolved game layout.
   * @returns {Promise<string[]>}
   */
  static async listKnownAccounts(layout) {
    return Fsx.listDirs(layout.users)
  }

  /**
   * Read the account that was active most recently.
   *
   * This is the natural default for an import: a world brought in from another
   * machine has to be attached to an account here before the client lists it.
   * @param {GameLayout} layout - Resolved game layout.
   * @returns {Promise<string|null>}
   */
  static async lastUserId(layout) {
    var parsed = await Fsx.readJsonLenient(layout.lastUserIdFile);

    if (parsed && typeof parsed.last_user_id === "string")
      return parsed.last_user_id

    return null
  }

  /**
   * Read the once-per-import account information.
   *
   * Both lookups touch the whole users directory, so they are done once and
   * shared across every world in a batch rather than per world.
   * @param {GameLayout} layout - Target layout.
   * @returns {Promise<{known: string[], active: string|null}>}
   */
  static async context(layout) {
    return {
      known: await UserFolders.listKnownAccounts(layout),
      active: await UserFolders.lastUserId(layout)
    }
  }

  /**
   * Build the account choices one world contributes.
   *
   * Account folders themselves are not managed: only the record's user_ids map
   * is written, so the origin of each suggestion is reported rather than acted
   * on.
   * @param {object} candidate - World candidate from the detector.
   * @param {object|null} candidate.record - Source registry entry.
   * @param {object} [candidate.usersPresent] - Accounts with a folder in the source.
   * @param {object} ctx - Context from context().
   * @returns {{candidates: object[], selected: string[]}}
   */
  static suggest(candidate, ctx) {
    var known = ctx.known
      , active = ctx.active
      , fromRecord = WorldRecord.userIds(candidate.record)
      , fromSource = Object.keys(candidate.usersPresent || {})
      , seen = new Set()
      , candidates = [];

    // The active account leads, then the accounts the source itself names, then
    // whatever else the client knows about on this machine.
    var ordered = active ? [active].concat(fromRecord, fromSource, known)
      : fromRecord.concat(fromSource, known);

    for (var uid of ordered) {
      if (seen.has(uid))
        continue

      seen.add(uid);
      candidates.push({
        uid: uid,
        active: uid === active,
        inRecord: fromRecord.includes(uid),
        inSource: fromSource.includes(uid),
        hasFolder: known.includes(uid)
      });
    }

    // Without an active account the source's own accounts are the only sensible
    // starting point.
    var selected = active ? [active] : fromRecord.slice();

    return { candidates: candidates, selected: selected }
  }

  /**
   * Describe where a candidate account came from, for display.
   * @param {object} entry - Candidate entry from suggest().
   * @returns {string}
   */
  static describe(entry) {
    var parts = [];

    if (entry.active)
      parts.push("当前账号");
    if (entry.inRecord)
      parts.push("来源记录");
    if (entry.inSource)
      parts.push("来源目录");
    if (entry.hasFolder)
      parts.push("本机已有目录");

    return parts.join(" · ") || "手动添加"
  }

  /**
   * Test whether an account id may be written into a record.
   * @param {string} uid - Candidate account id.
   * @returns {boolean}
   */
  static isValidId(uid) {
    return typeof uid === "string"
      && uid.length > 0
      && uid.length <= 64
      && /^[A-Za-z0-9_-]+$/.test(uid)
      && uid !== PLACEHOLDER_UID
  }

  /**
   * Collect the account folders an export should carry.
   *
   * Only leaf folders named exactly for this world are collected. A user folder
   * also holds unrelated state such as skin.txt, chat history and a
   * play_with.txt that reaches megabytes in the sample.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {string} levelId - Level id of the world.
   * @param {object|null} record - World record.
   * @param {object} [opts] - Options.
   * @param {boolean} [opts.includeOrphans] - Also collect folders the record does not claim.
   * @returns {Promise<{include: object[], omitted: string[]}>}
   */
  static async collectForExport(layout, levelId, record, opts) {
    var options = opts || {}
      , include = []
      , omitted = []
      , seen = new Set();

    for (var uid of WorldRecord.userIds(record)) {
      seen.add(uid);

      var dir = layout.userWorldDir(uid, levelId);

      if (await Fsx.existsDir(dir))
        include.push({ uid: uid, srcDir: dir, orphan: false });
      else
        omitted.push(uid);
    }

    if (options.includeOrphans) {
      for (var uid of await Fsx.listDirs(layout.users)) {
        if (seen.has(uid))
          continue

        var dir = layout.userWorldDir(uid, levelId);

        if (await Fsx.existsDir(dir))
          include.push({ uid: uid, srcDir: dir, orphan: true });
      }
    }

    return { include: include, omitted: omitted }
  }

  /**
   * Find accounts whose "continue last world" pointer names a given world.
   *
   * A re-minted import cannot repair this pointer, because account state is not
   * managed. Surfacing it lets the caller warn instead of leaving the user with
   * a resume that silently falls back to the world list.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {string[]} uids - Account ids to inspect.
   * @param {string} levelId - Level id the pointer would have to name.
   * @returns {Promise<string[]>} Accounts still pointing at that id.
   */
  static async findStalePointers(layout, uids, levelId) {
    var out = [];

    for (var uid of uids) {
      var data = await Fsx.readJsonLenient(layout.lastPlayDataFile(uid));

      if (data && data.level_id === levelId)
        out.push(uid);
    }

    return out
  }
}

module.exports = UserFolders;
