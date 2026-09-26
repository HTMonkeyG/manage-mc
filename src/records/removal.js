const fsp = require("fs/promises")
  , path = require("path")
  , crypto = require("crypto");

const Fsx = require("../os/fsx");
const GameLayout = require("../os/paths");
const RecordSchema = require("./schema");
const WorldRecord = require("./record");

// Deletions are staged here first. Moving a world out of minecraftWorlds and
// out of world_records is what makes it disappear; only then is the staged copy
// erased. A crash between the two leaves the world gone from the client's view
// with its bytes still recoverable under this folder.
const TRASH_DIR = ".manage-mc-trash";

class WorldRemoval {
  /**
   * Delete a world: its folder, its database, its record, and every account
   * folder belonging to it.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {object} entry - World entry to delete.
   * @param {object} [opts] - Options.
   * @param {boolean} [opts.purge] - Erase the staged copy, defaults to true.
   * @returns {Promise<object>} Removal report.
   */
  static async deleteWorld(layout, entry, opts) {
    var options = opts || {}
      , levelId = entry.levelId;

    if (!entry.worldDir && !entry.recordFile)
      throw new Error("该条目没有可删除的内容");

    if (!GameLayout.isSafeSegment(levelId))
      throw new Error(`level id 不能用作路径片段：${levelId}`);

    var targets = WorldRemoval.targetsFor(layout, levelId, await WorldRemoval.collectAccountUids(layout, levelId));

    // Every path is confined to the game root before anything moves, so a
    // crafted id cannot walk the deletion out of the tree.
    for (var target of targets)
      if (!Fsx.isInside(layout.root, target.path))
        throw new Error(`拒绝删除游戏根目录之外的路径：${target.path}`);

    var trashRoot = path.join(layout.root, TRASH_DIR, `${Fsx.stamp()}-${crypto.randomBytes(3).toString("hex")}`)
      , moved = [];

    await Fsx.mkdirp(trashRoot);

    try {
      for (var target of targets) {
        if (!(await Fsx.exists(target.path)))
          continue

        await Fsx.retry(() => fsp.rename(target.path, WorldRemoval.trashPath(trashRoot, target)));
        moved.push(target);
      }
    } catch (e) {
      // Put everything back, so a failed deletion leaves the world untouched.
      for (var done of moved.reverse())
        await Fsx.retry(() => fsp.rename(WorldRemoval.trashPath(trashRoot, done), done.path)).catch(() => {});

      await Fsx.remove(trashRoot);
      throw e
    }

    // The world is already out of the client's view. Erasing the staged copy is
    // the part that can fail without confusing the game, so it is reported
    // rather than treated as a failed delete.
    var warnings = []
      , purged = false;

    if (options.purge !== false) {
      try {
        await Fsx.remove(trashRoot);
        purged = true;

        // rmdir refuses a directory that still holds another staged deletion,
        // so this only clears the folder when nothing else is in it.
        await fsp.rmdir(path.dirname(trashRoot)).catch(() => {});
      } catch (e) {
        warnings.push(`暂存副本未能删除，可手动清理：${trashRoot}`);
      }
    } else {
      warnings.push(`暂存副本已保留：${trashRoot}`);
    }

    return {
      levelId: levelId,
      removed: moved.map(t => ({ kind: t.kind, uid: t.uid || null, path: t.path })),
      purged: purged,
      trashRoot: purged ? null : trashRoot,
      warnings: warnings
    }
  }

  /**
   * Drop accounts from a world's record, leaving the world itself in place.
   *
   * Only the record's user_ids is touched: the world folder, its database and
   * any per-account folder all stay exactly as they are, so the accounts can be
   * added back later.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {object} entry - World entry.
   * @param {string[]} uids - Account ids to drop.
   * @returns {Promise<object>} Removal report.
   */
  static async removeAccounts(layout, entry, uids) {
    var record = entry.record;

    if (!record)
      throw new Error("该条目没有注册表记录，无法删除账号记录");

    if (!Array.isArray(uids) || uids.length === 0)
      throw new Error("没有选择要删除的账号");

    var current = WorldRecord.userIds(record)
      , removing = uids.filter(uid => current.includes(uid));

    if (removing.length === 0)
      throw new Error("所选账号不在该记录中");

    var remaining = current.filter(uid => !removing.includes(uid))
      , next = Object.assign({}, record);

    // The same rule the import path uses, so timestamps and key order of the
    // accounts that stay are preserved exactly.
    next.user_ids = RecordSchema.applyUserIds(record.user_ids, remaining);

    await WorldRecord.write(layout, entry.levelId, next);

    return {
      levelId: entry.levelId,
      removed: removing,
      remaining: remaining,
      emptied: remaining.length === 0
    }
  }

  /**
   * Describe everything a full deletion would remove.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {string} levelId - Level id of the world.
   * @param {string[]} [accountUids] - Account ids to include.
   * @returns {object[]} Targets, in the order they are removed.
   */
  static targetsFor(layout, levelId, accountUids) {
    var targets = [
      { kind: "world", path: layout.worldDir(levelId) },
      { kind: "record", path: layout.recordFile(levelId) }
    ];

    for (var uid of accountUids || [])
      targets.push({ kind: "account", uid: uid, path: layout.userWorldDir(uid, levelId) });

    return targets
  }

  /**
   * Find the account folders that belong to a world.
   * @param {GameLayout} layout - Resolved game layout.
   * @param {string} levelId - Level id of the world.
   * @returns {Promise<string[]>} Account ids with a folder for this world.
   */
  static async collectAccountUids(layout, levelId) {
    var uids = await Fsx.listDirs(layout.users)
      , found = [];

    for (var uid of uids)
      if (await Fsx.existsDir(layout.userWorldDir(uid, levelId)))
        found.push(uid);

    return found
  }

  /**
   * Where a target is staged during a deletion.
   * @param {string} trashRoot - Staging directory.
   * @param {object} target - Target being removed.
   * @returns {string}
   */
  static trashPath(trashRoot, target) {
    var label = [target.kind, target.uid, path.basename(target.path)].filter(Boolean).join("-");

    return path.join(trashRoot, GameLayout.sanitizeSegment(label, 120) || "entry")
  }

  /**
   * Describe a removal report in one line.
   * @param {object} report - Report from deleteWorld().
   * @returns {string}
   */
  static summarize(report) {
    var kinds = { world: "世界目录", record: "注册表记录", account: "账号目录" }
      , counts = {};

    for (var item of report.removed)
      counts[item.kind] = (counts[item.kind] || 0) + 1;

    return Object.keys(counts).map(kind => `${kinds[kind] || kind} ${counts[kind]} 项`).join(" · ")
  }
}

module.exports = WorldRemoval;
