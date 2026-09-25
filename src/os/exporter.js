const fsp = require("fs/promises")
  , path = require("path")
  , crypto = require("crypto");

const Fsx = require("./fsx");
const GameLayout = require("./paths");
const LevelDat = require("./leveldat");
const Pack = require("./pack");
const RecordSchema = require("../records/schema");
const WorldRecord = require("../records/record");
const UserFolders = require("../records/users");

const MANIFEST_NAME = "manifest.json";
const README_NAME = "README.txt";
const FORMAT_ID = "manage-mc/world-export";
const FORMAT_VERSION = 1;

// A package is laid out as a partial game root, so it can be read by hand as
// well as imported. The canonical spelling is used inside a package regardless
// of the source's, because a package is a fresh artefact.
const PACKAGE_STORAGE = "storage";
const PACKAGE_WORLDS = "minecraftWorlds";
const PACKAGE_RECORDS = `${PACKAGE_STORAGE}/stream/resource_management/world_records`;
const PACKAGE_USERS = `${PACKAGE_STORAGE}/stream/users`;

// adm-zip assembles the whole archive in memory, so a very large world is a
// poor fit for the zip format.
const ZIP_SIZE_WARNING = 512 * 1024 * 1024;

class WorldExporter {
  /**
   * Export worlds into a package folder or a zip archive.
   * @param {GameLayout} layout - Resolved game layout of the source.
   * @param {object[]} entries - World entries to export.
   * @param {string} destDir - Directory to write the package into.
   * @param {object} [opts] - Options.
   * @param {"folder"|"zip"} [opts.format] - Package format, defaults to folder.
   * @param {string} [opts.name] - Override for the package name.
   * @param {boolean} [opts.includeUsers] - Collect per-user folders, default true.
   * @param {boolean} [opts.includeOrphanUsers] - Also collect folders no record claims.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @returns {Promise<object>} Export report.
   */
  static async exportWorlds(layout, entries, destDir, opts) {
    var options = opts || {}
      , format = options.format === "zip" ? "zip" : "folder";

    if (!Array.isArray(entries) || entries.length === 0)
      throw new Error("Nothing is selected for export");

    if (!(await Fsx.existsDir(destDir)))
      throw new Error(`Destination folder does not exist: ${destDir}`);

    if (format === "zip" && !Pack.available())
      throw new Error("Zip support needs the adm-zip package. Install it with: npm install adm-zip");

    var name = WorldExporter.packageName(layout, entries, options.name)
      , packageRoot = path.join(destDir, name)
      , zipPath = format === "zip" ? `${packageRoot}.zip` : null
      , finalTarget = zipPath || packageRoot;

    if (await Fsx.exists(finalTarget))
      throw new Error(`Destination already exists: ${finalTarget}`);

    // Staging sits beside the destination so the final rename stays within one
    // volume and is therefore atomic.
    var stagingRoot = path.join(destDir, `.manage-mc-export-${Fsx.stamp()}-${crypto.randomBytes(3).toString("hex")}`)
      , staged = path.join(stagingRoot, "pkg")
      , warnings = []
      , plans = [];

    await Fsx.mkdirp(staged);

    try {
      for (var entry of entries) {
        var plan = await WorldExporter.planEntry(layout, entry, options);

        if (plan.worldPresent) {
          var copied = await Fsx.copyTree(entry.worldDir, path.join(staged, PACKAGE_WORLDS, entry.levelId), {
            signal: options.signal,
            onProgress: progress => {
              if (options.onProgress)
                options.onProgress(Object.assign({ levelId: entry.levelId }, progress));
            }
          });

          if (copied.aborted)
            throw WorldExporter.cancelled();

          // Recorded so a consumer can tell a complete package from one that
          // was truncated in transit.
          plan.integrity = { algorithm: "counts", fileCount: copied.files, totalBytes: copied.bytes };
        }

        // The registry row travels even when the world data does not, which is
        // the only way to carry an online world's entry to another machine.
        await Fsx.atomicWriteText(
          path.join(staged, PACKAGE_RECORDS, `${entry.levelId}.json`),
          JSON.stringify(plan.record)
        );

        for (var user of plan.users) {
          if (!user.srcDir)
            continue

          await Fsx.copyTree(
            user.srcDir,
            path.join(staged, PACKAGE_USERS, user.uid, entry.levelId),
            { signal: options.signal }
          );
        }

        plans.push(plan);
      }

      var totals = WorldExporter.totals(plans);

      if (format === "zip" && totals.bytes > ZIP_SIZE_WARNING)
        warnings.push(`package is ${Fsx.humanSize(totals.bytes)}; a zip is assembled in memory and may exhaust it`);

      var manifest = WorldExporter.buildManifest(layout, plans, totals);
      await Fsx.atomicWriteJson(path.join(staged, MANIFEST_NAME), manifest);
      await Fsx.atomicWriteText(path.join(staged, README_NAME), WorldExporter.readmeText());

      if (format === "zip")
        warnings.push(...await WorldExporter.writeZip(staged, zipPath, options));
      else
        await Fsx.retry(() => fsp.rename(staged, packageRoot));
    } catch (e) {
      await Fsx.remove(stagingRoot);
      throw e
    }

    await Fsx.remove(stagingRoot);

    return {
      ok: true,
      target: finalTarget,
      name: name,
      format: format,
      worlds: plans.length,
      bytes: plans.reduce((sum, p) => sum + (p.integrity ? p.integrity.totalBytes : 0), 0),
      files: plans.reduce((sum, p) => sum + (p.integrity ? p.integrity.fileCount : 0), 0),
      warnings: warnings,
      manifest: manifest
    }
  }

  /**
   * Plan the package contents of one world.
   * @param {GameLayout} layout - Source layout.
   * @param {object} entry - World entry.
   * @param {object} options - Export options.
   * @returns {Promise<object>} Entry plan.
   */
  static async planEntry(layout, entry, options) {
    var worldPresent = entry.worldDir !== null
      , record = entry.record
      , synthesized = false
      , notes = []
      , meta = entry.levelMeta;

    if (worldPresent && !meta)
      meta = await LevelDat.readMeta(entry.worldDir);

    if (!record) {
      // An unregistered folder has no registry row, so one is synthesized to
      // let the world become visible after a round trip.
      var built = RecordSchema.buildImported(null, {
        levelId: entry.levelId,
        layout: layout,
        worldPresent: worldPresent,
        worldDir: entry.worldDir,
        levelMeta: meta
      });

      record = built.record;

      // A package has no target root yet, so the path stays a package relative
      // marker that an import replaces with the real target path.
      record.path = `${PACKAGE_WORLDS}/${entry.levelId}`;
      synthesized = true;
      notes = notes.concat(built.notes);
    }

    var users = { include: [], omitted: WorldRecord.userIds(record) };

    if (worldPresent && options.includeUsers !== false)
      users = await UserFolders.collectForExport(layout, entry.levelId, entry.record, {
        includeOrphans: Boolean(options.includeOrphanUsers)
      });

    if (!worldPresent && users.omitted.length > 0)
      notes.push("no world data is present, so only the registry entry is exported");

    return {
      levelId: entry.levelId,
      originalLevelId: entry.levelId,
      displayName: entry.displayName,
      worldPresent: worldPresent,
      recordPresent: entry.record !== null,
      recordSynthesized: synthesized,
      isLocal: Boolean(record.is_local),
      isCopy: Boolean(record.is_copy),
      levelMeta: WorldExporter.summarizeMeta(meta),
      users: users.include,
      usersOmitted: users.omitted,
      notes: notes,
      record: record,
      integrity: null
    }
  }

  /**
   * Sum the sizes of the planned worlds.
   * @param {object[]} plans - Entry plans.
   * @returns {{files: number, bytes: number}}
   */
  static totals(plans) {
    var files = 0
      , bytes = 0;

    for (var plan of plans) {
      if (!plan.integrity)
        continue
      files += plan.integrity.fileCount;
      bytes += plan.integrity.totalBytes;
    }

    return { files: files, bytes: bytes }
  }

  /**
   * Build the package manifest.
   * @param {GameLayout} layout - Source layout.
   * @param {object[]} plans - Entry plans.
   * @param {object} totals - Summed sizes.
   * @returns {object}
   */
  static buildManifest(layout, plans, totals) {
    return {
      format: FORMAT_ID,
      formatVersion: FORMAT_VERSION,
      producer: WorldExporter.producerInfo(),
      exportedAt: new Date().toISOString(),
      source: {
        root: layout.rootPosix,
        rootSpelling: layout.spelling,
        host: process.platform
      },
      totals: totals,
      worlds: plans.map(plan => ({
        levelId: plan.levelId,
        originalLevelId: plan.originalLevelId,
        displayName: plan.displayName,
        worldPresent: plan.worldPresent,
        recordPresent: plan.recordPresent,
        recordSynthesized: plan.recordSynthesized,
        isLocal: plan.isLocal,
        isCopy: plan.isCopy,
        levelMeta: plan.levelMeta,
        worldPath: plan.worldPresent ? `${PACKAGE_WORLDS}/${plan.levelId}` : null,
        recordPath: `${PACKAGE_RECORDS}/${plan.levelId}.json`,
        users: plan.users.map(user => ({
          uid: user.uid,
          path: `${PACKAGE_USERS}/${user.uid}/${plan.levelId}`,
          mode: user.srcDir ? "copy" : "empty",
          orphan: Boolean(user.orphan)
        })),
        usersOmitted: plan.usersOmitted,
        integrity: plan.integrity,
        notes: plan.notes
      }))
    }
  }

  /**
   * Reduce level.dat metadata to the fields worth carrying in a manifest.
   * @param {object|null} meta - Parsed metadata.
   * @returns {object|null}
   */
  static summarizeMeta(meta) {
    if (!meta)
      return null

    return {
      levelName: meta.levelName || meta.levelNameFile || null,
      lastPlayed: meta.lastPlayed === undefined ? null : meta.lastPlayed,
      gameType: meta.gameType === undefined ? null : meta.gameType,
      gameMode: meta.gameMode || null,
      storageVersion: meta.storageVersion === undefined ? null : meta.storageVersion,
      networkVersion: meta.networkVersion === undefined ? null : meta.networkVersion,
      inventoryVersion: meta.inventoryVersion || null,
      isHardcore: Boolean(meta.isHardcore)
    }
  }

  /**
   * Build a package name that is safe on every platform.
   * @param {GameLayout} layout - Source layout.
   * @param {object[]} entries - Worlds being exported.
   * @param {string} [override] - User supplied name.
   * @returns {string}
   */
  static packageName(layout, entries, override) {
    if (override) {
      var clean = GameLayout.sanitizeSegment(override, 80);
      return clean || "export"
    }

    var stamp = Fsx.stamp();

    if (entries.length === 1) {
      var entry = entries[0]
        , label = GameLayout.sanitizeSegment(entry.displayName, 60)
        , id = GameLayout.sanitizeSegment(entry.levelId, 40);

      return [label, id, stamp].filter(Boolean).join("_")
    }

    var base = GameLayout.sanitizeSegment(path.basename(layout.root), 40) || "worlds";
    return `${base}_all_${stamp}`
  }

  /**
   * Write the staged package into a zip archive.
   * @param {string} staged - Staged package directory.
   * @param {string} zipPath - Archive to create.
   * @param {object} options - Export options.
   * @returns {Promise<string[]>} Warnings.
   */
  static async writeZip(staged, zipPath, options) {
    var result = await Pack.zipDirectory(staged, zipPath, {
      signal: options.signal,
      onProgress: options.onProgress
    });

    if (result.aborted)
      throw WorldExporter.cancelled();

    return result.warnings
  }

  /**
   * Build an error marked as a user cancellation.
   * @returns {Error}
   */
  static cancelled() {
    var err = new Error("Export cancelled");
    err.aborted = true;
    return err
  }

  /**
   * Read the producer identity from the package manifest.
   * @returns {{name: string, version: string}}
   */
  static producerInfo() {
    try {
      var pkg = require("../../package.json");
      return { name: pkg.name, version: pkg.version }
    } catch (e) {
      return { name: "@htmonkeyg/manage-mc", version: "0.0.0" }
    }
  }

  /**
   * Build the human readable note shipped inside a package.
   * @returns {string}
   */
  static readmeText() {
    return [
      "This folder is a Minecraft (NetEase PC) world export produced by manage-mc.",
      "",
      "Layout:",
      `  ${MANIFEST_NAME}   package description, one entry per world`,
      `  ${PACKAGE_WORLDS}/<level_id>/   the world data, copied byte for byte`,
      `  ${PACKAGE_RECORDS}/<level_id>.json   the registry entry the client reads`,
      `  ${PACKAGE_USERS}/<uid>/<level_id>/   per-account world folders`,
      "",
      "Import this package with manage-mc rather than copying it by hand: the",
      "record's path field names the machine it was exported from, and the",
      "importer rewrites it for the target installation.",
      ""
    ].join("\n")
  }
}

module.exports = WorldExporter;
