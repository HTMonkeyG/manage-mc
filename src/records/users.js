const Fsx = require("../os/fsx");
const GameLayout = require("../os/paths");
const WorldRecord = require("./record");

// The client creates a literal folder named "None" for a signed-out account.
// It is a client artefact rather than user data, so it is never recreated
// unless the user asks for it by name.
const PLACEHOLDER_UID = "None";

class UserFolders {
  /**
   * Plan the per-user folders an import should create.
   *
   * The default selection is the accounts the source actually carries data for,
   * falling back to the accounts the record claims. That is already the union
   * the plan calls for: the accounts both claimed and supplied are a subset of
   * the accounts supplied.
   * @param {object} cand - World candidate.
   * @param {object} cand.levelId - Effective level id.
   * @param {object} cand.record - Source record, or null.
   * @param {object} cand.usersPresent - Account id mapped to source folder.
   * @param {GameLayout} layout - Target layout.
   * @param {object} [opts] - Options.
   * @param {string[]} [opts.add] - Account ids to add explicitly.
   * @param {string[]} [opts.remove] - Account ids to drop.
   * @param {string} [opts.mode] - "copy" copies source contents, "empty" only creates.
   * @returns {{create: object[], skipped: object[], warnings: string[]}}
   */
  static plan(cand, layout, opts) {
    var options = opts || {}
      , present = Object.keys(cand.usersPresent || {})
      , claimed = WorldRecord.userIds(cand.record)
      , explicit = options.add || []
      , selected = new Set(present.length > 0 ? present : claimed)
      , create = []
      , skipped = []
      , warnings = [];

    for (var uid of explicit)
      selected.add(uid);

    for (var uid of options.remove || [])
      selected.delete(uid);

    for (var uid of selected) {
      if (!GameLayout.isSafeSegment(uid)) {
        skipped.push({ uid: uid, reason: "not usable as a folder name" });
        continue
      }

      if (uid === PLACEHOLDER_UID && !explicit.includes(uid)) {
        skipped.push({ uid: uid, reason: "placeholder account, not created unless requested" });
        continue
      }

      var srcDir = (cand.usersPresent || {})[uid] || null;

      create.push({
        uid: uid,
        srcDir: srcDir,
        destDir: layout.userWorldDir(uid, cand.levelId),
        mode: srcDir && options.mode !== "empty" ? "copy" : "empty"
      });
    }

    return { create: create, skipped: skipped, warnings: warnings }
  }

  /**
   * Create the planned per-user folders.
   *
   * Failures here are deliberately non-fatal: the world itself is already
   * published by this point, and a locked per-user config file must not undo a
   * good import.
   * @param {object} plan - Plan produced by plan().
   * @param {object} [opts] - Options.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @returns {Promise<{created: string[], copied: string[], warnings: string[]}>}
   */
  static async execute(plan, opts) {
    var options = opts || {}
      , created = []
      , copied = []
      , warnings = [];

    for (var step of plan.create) {
      try {
        await Fsx.mkdirp(step.destDir);
        created.push(step.uid);
      } catch (e) {
        warnings.push(`account ${step.uid}: ${e.message}`);
        continue
      }

      if (step.mode !== "copy" || !step.srcDir)
        continue

      try {
        await Fsx.copyTree(step.srcDir, step.destDir, { signal: options.signal });
        copied.push(step.uid);
      } catch (e) {
        // The folder exists, so the world still works; the per-user state is
        // simply empty for this account.
        warnings.push(`account ${step.uid}: contents not copied (${e.message})`);
      }
    }

    return { created: created, copied: copied, warnings: warnings }
  }

  /**
   * Collect the per-user folders an export should carry.
   *
   * Only leaf folders named exactly for this world are collected. A user
   * folder also holds unrelated state such as skin.txt, chat history and a
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
   * Read the account that was active most recently.
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
   * Find accounts whose "continue last world" pointer names a given world.
   *
   * A re-minted import cannot repair this pointer, because the account policy
   * only creates folders. Surfacing it lets the caller warn instead of leaving
   * the user with a resume that silently falls back to the world list.
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
