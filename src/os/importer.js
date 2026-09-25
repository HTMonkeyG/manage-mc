const fsp = require("fs/promises")
  , path = require("path")
  , crypto = require("crypto");

const Fsx = require("./fsx");
const LevelDat = require("./leveldat");
const XorEnc = require("./xorenc");
const LevelId = require("../records/levelid");
const RecordSchema = require("../records/schema");
const UserFolders = require("../records/users");
const WorldRecord = require("../records/record");

// Staging lives under the game root so the publish rename stays on one volume
// and is therefore atomic.
const STAGING_DIR = ".manage-mc-tmp";

// LevelDB holds an exclusive lock on this file while the client has the world
// open.
const DB_LOCK = "LOCK";
const RECENT_ACTIVITY_MS = 60 * 1000;

const FREE_SPACE_FACTOR = 1.1;
const FREE_SPACE_MARGIN = 64 * 1024 * 1024;

// NTFS limits one path component to 255 UTF-16 code units; the whole path is
// limited separately by the classic 260 character maximum.
const MAX_COMPONENT = 255;
const MAX_PATH_WARN = 259;

const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

class WorldImporter {
  /**
   * Plan an import without touching the target.
   * @param {GameLayout} layout - Target layout.
   * @param {object} source - Source produced by SourceDetector.detect().
   * @param {object} [opts] - Options.
   * @param {"copy"|"replace"|"merge"} [opts.onCollision] - Collision policy.
   * @param {string[]} [opts.select] - Level ids to import, defaults to all.
   * @param {string[]} [opts.userIds] - Accounts to record, or undefined to keep the source's.
   * @returns {Promise<object>} Import plan.
   */
  static async plan(layout, source, opts) {
    var options = opts || {}
      , policy = options.onCollision || "copy"
      , taken = await LevelId.collectTaken(layout)
      , steps = []
      , warnings = (source.warnings || []).slice();

    for (var candidate of source.worlds) {
      if (options.select && !options.select.includes(candidate.levelId))
        continue

      var step = await WorldImporter.planStep(layout, candidate, policy, taken, options);
      steps.push(step);
      warnings.push(...step.warnings);
    }

    if (steps.length === 0)
      throw new Error("Nothing was selected for import");

    return {
      layout: layout,
      source: source,
      steps: steps,
      warnings: warnings,
      bytes: steps.reduce((sum, s) => sum + s.size.bytes, 0),
      files: steps.reduce((sum, s) => sum + s.size.files, 0)
    }
  }

  /**
   * Plan a single world.
   * @param {GameLayout} layout - Target layout.
   * @param {object} candidate - World candidate.
   * @param {string} policy - Collision policy.
   * @param {Set<string>} taken - Ids already allocated in this run.
   * @param {object} options - Import options.
   * @returns {Promise<object>} Import step.
   */
  static async planStep(layout, candidate, policy, taken, options) {
    var warnings = []
      , uids = WorldImporter.uidsOf(candidate)
      , destId = candidate.levelId
      , minted = false;

    if (!LevelId.isSafe(destId)) {
      destId = LevelId.mint(layout, taken);
      minted = true;
      warnings.push(`"${candidate.levelId}" cannot be used as a folder name; minted ${destId}`);
    } else {
      // All three namespaces are probed: an orphan account folder left behind
      // by a deleted world would otherwise be silently re-attached.
      var probe = await LevelId.probeCollision(layout, destId, uids);

      if (probe.any) {
        if (policy === "replace") {
          warnings.push(`replacing the existing world ${destId}`);
        } else if (policy === "merge" && !probe.folder && !probe.record) {
          warnings.push(`merging into ${probe.userFolders.length} existing account folder(s)`);
        } else {
          var fresh = LevelId.mint(layout, taken);

          if (policy === "merge")
            warnings.push("merge is not possible because a world folder or record already exists; importing as a copy");

          warnings.push(`${destId} already exists; importing as a copy under ${fresh}`);
          destId = fresh;
          minted = true;
        }
      }

      taken.add(destId);
    }

    var levelMeta = candidate.worldDir ? await LevelDat.readMeta(candidate.worldDir) : null
      , worldPresent = candidate.worldDir !== null;

    var built = RecordSchema.buildImported(candidate.record, {
      levelId: destId,
      layout: layout,
      worldPresent: worldPresent,
      worldDir: candidate.worldDir,
      levelMeta: levelMeta,
      userIds: options.userIds
    });

    // Account folders are not created: the selected accounts are written into
    // the record's user_ids, and that map is what the client reads.
    var size = worldPresent ? await Fsx.du(candidate.worldDir) : { files: 0, bytes: 0 };

    // A package whose database was decrypted for export has to be encrypted
    // again, because the client only reads an encrypted database. The recorded
    // file list says exactly which files the encryption covered, which matters
    // because a plain ".log" must stay plain.
    var xor = candidate.manifest && candidate.manifest.xor && candidate.manifest.xor.decrypted
      ? {
          files: Array.isArray(candidate.manifest.xor.files) ? candidate.manifest.xor.files : null,
          originalKeyAscii: candidate.manifest.xor.keyAscii || null
        }
      : null;

    // A re-minted id cannot be pushed into the read-only account state, so the
    // stale resume pointer is reported instead of silently left behind.
    if (minted && worldPresent) {
      var stale = await UserFolders.findStalePointers(layout, Object.keys(candidate.usersPresent || {}), candidate.levelId);

      if (stale.length > 0)
        warnings.push(`account ${stale.join(", ")} still points its "continue last world" entry at ${candidate.levelId}; the client will fall back to the world list`);
    }

    return {
      candidate: candidate,
      originalLevelId: candidate.levelId,
      destId: destId,
      minted: minted,
      worldPresent: worldPresent,
      record: built.record,
      synthesized: built.synthesized,
      notes: built.notes,
      levelMeta: levelMeta,
      size: size,
      xor: xor,
      warnings: warnings
    }
  }

  /**
   * Collect every account id a candidate refers to.
   * @param {object} candidate - World candidate.
   * @returns {string[]}
   */
  static uidsOf(candidate) {
    var ids = new Set(Object.keys(candidate.usersPresent || {}));

    for (var uid of WorldRecord.userIds(candidate.record))
      ids.add(uid);

    return Array.from(ids)
  }

  /**
   * Check that an import can proceed.
   *
   * Runs before the first byte is written, so a refusal leaves the target
   * completely untouched.
   * @param {object} plan - Import plan.
   * @param {GameLayout} layout - Target layout.
   * @returns {Promise<{ok: boolean, problems: object[], warnings: string[]}>}
   */
  static async preflight(plan, layout) {
    var problems = []
      , warnings = [];

    if (!(await Fsx.existsDir(layout.minecraftWorlds)))
      problems.push({ code: "ENOWORLDS", message: `minecraftWorlds is missing: ${layout.minecraftWorlds}` });

    if (problems.length === 0 && !(await WorldImporter.probeWritable(layout.minecraftWorlds)))
      problems.push({ code: "EREADONLY", message: `No write access to ${layout.minecraftWorlds}` });

    var free = await Fsx.freeSpace(layout.root)
      , inUse = await WorldImporter.detectGameInUse(layout, plan);

    problems.push(...inUse.blocked.map(message => ({ code: "EINUSE", message: message })));
    warnings.push(...inUse.warnings);

    for (var step of plan.steps) {
      var need = Math.ceil(step.size.bytes * FREE_SPACE_FACTOR) + FREE_SPACE_MARGIN;

      if (free < need)
        problems.push({
          code: "ENOSPC",
          message: `Not enough free space for "${step.record.name}": about ${Fsx.humanSize(need)} needed, ${Fsx.humanSize(free)} free`
        });

      var destWorld = layout.worldDir(step.destId);

      // A hostile source could otherwise redirect a write outside the root
      // through a link or a traversing id.
      if (!Fsx.isInside(layout.root, destWorld))
        problems.push({ code: "EOUTSIDE", message: `Refusing to write outside the game root: ${destWorld}` });

      if (await Fsx.isReparsePoint(destWorld))
        problems.push({ code: "EREPARSE", message: `Refusing to write through a link: ${destWorld}` });

      if (!step.worldPresent)
        continue

      var walk = await Fsx.walkTree(step.candidate.worldDir, {})
        , deepest = destWorld.length + 1 + walk.maxRelLen
        , reserved = walk.entries.find(e => RESERVED_NAMES.test(path.basename(e.rel)));

      if (walk.maxNameLen > MAX_COMPONENT)
        problems.push({
          code: "ENAMETOOLONG",
          message: `A name inside "${step.record.name}" is ${walk.maxNameLen} characters, beyond the ${MAX_COMPONENT} character limit`
        });

      if (reserved)
        problems.push({ code: "ERESERVED", message: `A reserved Windows name would be created: ${reserved.rel}` });

      if (deepest > MAX_PATH_WARN)
        warnings.push(`"${step.record.name}" would be copied to a path of ${deepest} characters, beyond the classic limit`);
    }

    return { ok: problems.length === 0, problems: problems, warnings: warnings }
  }

  /**
   * Confirm a directory is writable by actually writing to it.
   *
   * An access() check reports success under Windows ACLs and Controlled Folder
   * Access even when the write is later refused, so the probe is a real write.
   * @param {string} dir - Directory to test.
   * @returns {Promise<boolean>}
   */
  static async probeWritable(dir) {
    var probe = path.join(dir, `.manage-mc-probe-${process.pid}`);

    try {
      await fsp.writeFile(probe, "");
      await fsp.unlink(probe);
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Detect whether the client is holding a target world open.
   *
   * Only the lock file and recent write activity are inspected. Renaming the
   * live database as a lock probe is deliberately avoided: a crash between the
   * two renames would leave a world's db folder renamed, which is a worse
   * outcome than the signal it would provide.
   * @param {GameLayout} layout - Target layout.
   * @param {object} plan - Import plan.
   * @returns {Promise<{blocked: string[], warnings: string[]}>}
   */
  static async detectGameInUse(layout, plan) {
    var blocked = []
      , warnings = [];

    for (var step of plan.steps) {
      var worldDir = layout.worldDir(step.destId);

      if (!(await Fsx.existsDir(worldDir)))
        continue

      if (await Fsx.exists(path.join(worldDir, "db", DB_LOCK))) {
        blocked.push(`The client is holding "${step.destId}" open. Close Minecraft and try again.`);
        continue
      }

      var dbEntries = await Fsx.readdir(path.join(worldDir, "db"))
        , newest = 0;

      for (var entry of dbEntries) {
        if (!entry.isFile() || !/\.(log|ldb)$/i.test(entry.name))
          continue

        var stat = await fsp.stat(path.join(worldDir, "db", entry.name));

        if (stat.mtimeMs > newest)
          newest = stat.mtimeMs;
      }

      if (newest > 0 && Date.now() - newest < RECENT_ACTIVITY_MS)
        warnings.push(`"${step.destId}" was written to within the last minute; the client may still be running`);
    }

    return { blocked: blocked, warnings: warnings }
  }

  /**
   * Run an import.
   *
   * Each world is staged, published with a single rename, then registered.
   * Writing the record last means any interruption leaves an unregistered
   * folder, which the world list can see and repair, rather than a record
   * pointing at nothing.
   * @param {object} plan - Import plan.
   * @param {object} [opts] - Options.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @returns {Promise<object>} Import report.
   */
  static async execute(plan, opts) {
    var options = opts || {}
      , layout = plan.layout
      , started = Date.now()
      , warnings = (plan.warnings || []).slice()
      , results = []
      , stagingRoot = path.join(layout.root, STAGING_DIR, `${Fsx.stamp()}-${crypto.randomBytes(3).toString("hex")}`);

    await Fsx.mkdirp(stagingRoot);

    try {
      for (var step of plan.steps) {
        var result = await WorldImporter.executeStep(layout, step, stagingRoot, options);
        results.push(result);
        warnings.push(...result.warnings);
      }
    } finally {
      await Fsx.remove(stagingRoot);
    }

    return {
      ok: true,
      results: results,
      warnings: warnings,
      elapsedMs: Date.now() - started
    }
  }

  /**
   * Run the import of a single world.
   * @param {GameLayout} layout - Target layout.
   * @param {object} step - Import step.
   * @param {string} stagingRoot - Directory to stage into.
   * @param {object} options - Import options.
   * @returns {Promise<object>} Step report.
   */
  static async executeStep(layout, step, stagingRoot, options) {
    var warnings = []
      , staged = path.join(stagingRoot, `world-${crypto.randomBytes(4).toString("hex")}`)
      , destWorld = layout.worldDir(step.destId)
      , destRecord = layout.recordFile(step.destId)
      , worldAside = null
      , recordAside = null
      , published = false
      , recordWritten = false
      , xorResult = null;

    await layout.ensureStorage();

    try {
      // Phase 1: stage the data and verify it before anything is published.
      if (step.worldPresent) {
        var copied = await Fsx.copyTree(step.candidate.worldDir, staged, {
          signal: options.signal,
          onProgress: progress => {
            if (options.onProgress)
              options.onProgress(Object.assign({ levelId: step.destId, phase: "copying" }, progress));
          }
        });

        if (copied.aborted)
          throw WorldImporter.cancelled();

        if (copied.files !== step.size.files || copied.bytes !== step.size.bytes)
          throw new Error(`Staged copy of "${step.record.name}" does not match the source`);

        // Restore the database encryption the client expects. This runs on the
        // staged copy, so a failure cannot leave a half-converted database
        // published. The default key is used: it is the key the client itself
        // applies, so it is what the world has to carry to be playable.
        if (step.xor) {
          var encrypted = await XorEnc.encryptDir(path.join(staged, "db"), {
            files: step.xor.files,
            signal: options.signal
          });

          xorResult = {
            files: encrypted.files.length,
            keyAscii: encrypted.keyAscii,
            originalKeyAscii: step.xor.originalKeyAscii
          };

          if (encrypted.files.length === 0)
            warnings.push(`"${step.record.name}": no database file needed encrypting`);
          else if (step.xor.originalKeyAscii && step.xor.originalKeyAscii !== encrypted.keyAscii)
            warnings.push(`"${step.record.name}": re-encrypted with the default key ${encrypted.keyAscii}, not the exported key ${step.xor.originalKeyAscii}`);
        }

        if (options.onProgress)
          options.onProgress({
            levelId: step.destId,
            phase: "publishing",
            files: copied.files,
            filesTotal: copied.files,
            bytes: copied.bytes,
            bytesTotal: copied.bytes,
            currentPath: "",
            elapsedMs: 0,
            etaMs: 0
          });

        // Phase 2: publish with one directory rename, so the destination never
        // exists in a half-copied state.
        if (await Fsx.exists(destWorld)) {
          worldAside = `${destWorld}.bak-${Fsx.stamp()}`;
          await Fsx.retry(() => fsp.rename(destWorld, worldAside));
        }

        await Fsx.retry(() => fsp.rename(staged, destWorld));
        published = true;
      }

      // Phase 3: the record, last of all. There is no account folder phase:
      // the selected accounts live in the record's user_ids and nothing else.
      recordAside = await Fsx.renameAside(destRecord);
      await WorldRecord.write(layout, step.destId, step.record);
      recordWritten = true;

      if (worldAside)
        await Fsx.remove(worldAside);
      if (recordAside)
        await Fsx.remove(recordAside);
    } catch (e) {
      await WorldImporter.rollback(layout, {
        destWorld, destRecord, worldAside, recordAside, published, recordWritten
      });

      if (options.signal && options.signal.aborted)
        throw WorldImporter.cancelled();

      throw e
    }

    return {
      levelId: step.destId,
      originalLevelId: step.originalLevelId,
      minted: step.minted,
      worldPresent: step.worldPresent,
      record: step.record,
      bytes: step.size.bytes,
      files: step.size.files,
      userIds: WorldRecord.userIds(step.record),
      synthesized: step.synthesized,
      xor: xorResult,
      warnings: warnings
    }
  }

  /**
   * Undo a partially applied step.
   *
   * A replaced world is always restored. A fresh import is left in place as an
   * unregistered folder when only the record write failed, because that is a
   * state the world list can see and repair, and re-copying the data would
   * otherwise be wasted work.
   * @param {GameLayout} layout - Target layout.
   * @param {object} state - Rollback state.
   * @returns {Promise<void>}
   */
  static async rollback(layout, state) {
    if (state.recordWritten)
      await Fsx.remove(state.destRecord).catch(() => {});

    if (state.recordAside)
      await Fsx.retry(() => fsp.rename(state.recordAside, state.destRecord)).catch(() => {});

    if (!state.published)
      return

    if (state.worldAside) {
      // A previous world existed, so the failed import must not consume it.
      await Fsx.remove(state.destWorld).catch(() => {});
      await Fsx.retry(() => fsp.rename(state.worldAside, state.destWorld)).catch(() => {});
    }
  }

  /**
   * Register an existing world folder that has no record.
   *
   * This is what makes the record-last ordering safe: an interrupted import
   * leaves exactly this state, and it is repairable in one step.
   * @param {GameLayout} layout - Target layout.
   * @param {object} entry - World entry holding a folder but no record.
   * @param {object} [opts] - Options.
   * @param {string} levelId - Override for the level id.
   * @returns {Promise<object>} Repair report.
   */
  static async repair(layout, entry, opts) {
    if (!entry.worldDir)
      throw new Error("Only a world folder can be registered")

    var options = opts || {}
      , levelId = options.levelId || entry.levelId
      , meta = await LevelDat.readMeta(entry.worldDir);

    var built = RecordSchema.buildImported(null, {
      levelId: levelId,
      layout: layout,
      worldPresent: true,
      worldDir: entry.worldDir,
      levelMeta: meta,
      userIds: options.userIds
    });

    // The registry is authoritative for visibility, so writing the row is what
    // turns an orphan folder into a world the client lists.
    await WorldRecord.write(layout, levelId, built.record);

    return { levelId: levelId, record: built.record, notes: built.notes }
  }

  /**
   * Build an error marked as a user cancellation.
   * @returns {Error}
   */
  static cancelled() {
    var err = new Error("Import cancelled");
    err.aborted = true;
    return err
  }
}

module.exports = WorldImporter;
