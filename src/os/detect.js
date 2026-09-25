const fsp = require("fs/promises")
  , os = require("os")
  , path = require("path")
  , crypto = require("crypto");

const Fsx = require("./fsx");
const GameLayout = require("./paths");
const Pack = require("./pack");
const WorldRecord = require("../records/record");
const WorldRegistry = require("../records/registry");

const MANIFEST_NAME = "manifest.json";
const MANIFEST_FORMAT = "manage-mc/world-export";
const PACKAGE_RECORDS = "storage/stream/resource_management/world_records";
const PACKAGE_USERS = "storage/stream/users";
const PACKAGE_WORLDS = "minecraftWorlds";
const ZIP_SUFFIX = ".zip";

// Weights for looksLikeWorld. A level.dat alone is enough, and db/CURRENT plus
// levelname.txt is enough without one, but a bare db folder is not.
const SCORE_LEVEL_DAT = 3;
const SCORE_LEVELNAME = 2;
const SCORE_DB_CURRENT = 2;
const SCORE_DB_MANIFEST = 1;
const SCORE_DB_TABLE = 1;
const WORLD_THRESHOLD = 3;

class SourceDetector {
  /**
   * Classify an import source and extract its worlds.
   * @param {string} inputPath - File or directory chosen by the user.
   * @param {object} [ctx] - Options.
   * @param {string} [ctx.tmpRoot] - Directory used to extract a zip.
   * @returns {Promise<object>} Detected source.
   */
  static async detect(inputPath, ctx) {
    var options = ctx || {}
      , resolved = path.resolve(inputPath);

    if (!(await Fsx.exists(resolved)))
      throw new Error(`Import source does not exist: ${resolved}`);

    var stat = await fsp.stat(resolved);

    if (stat.isFile())
      return SourceDetector.detectFile(resolved, options);

    return SourceDetector.detectDir(resolved, options);
  }

  /**
   * Classify a source that is a regular file.
   * @param {string} file - Absolute file path.
   * @param {object} options - Detection options.
   * @returns {Promise<object>} Detected source.
   */
  static async detectFile(file, options) {
    if (file.toLowerCase().endsWith(ZIP_SUFFIX)) {
      var tmpRoot = options.tmpRoot || path.join(os.tmpdir(), "manage-mc-import")
        , extractDir = path.join(tmpRoot, crypto.randomBytes(6).toString("hex"));

      // Extraction happens before classification, because the archive's own
      // contents decide whether it is a package, a world or a whole root.
      var unzipped = await Pack.unzipTo(file, extractDir)
        , inner = await SourceDetector.unwrapSingleFolder(extractDir)
        , source = await SourceDetector.detectDir(inner, options);

      source.kind = `zip:${source.kind}`;
      source.isTemp = true;
      source.tempRoot = extractDir;
      source.warnings = unzipped.warnings.concat(source.warnings);

      return source
    }

    if (path.basename(file).toLowerCase() === "level.dat")
      return SourceDetector.detectDir(path.dirname(file), options);

    throw new Error(`Unsupported import source file: ${file}`)
  }

  /**
   * Classify a source that is a directory.
   * @param {string} dir - Absolute directory path.
   * @param {object} options - Detection options.
   * @returns {Promise<object>} Detected source.
   */
  static async detectDir(dir, options) {
    var warnings = []
      , manifest = await SourceDetector.readManifest(dir);

    // Most specific first: a package carries our own manifest, which settles
    // the question without guessing at the layout.
    if (manifest)
      return SourceDetector.fromManifest(dir, manifest, warnings);

    var entries = await Fsx.readdir(dir)
      , worldsName = GameLayout.findDir(entries, "minecraftworlds")
      , storageName = ["storge", "storage"]
          .map(name => GameLayout.findDir(entries, name))
          .find(name => name !== undefined && name !== null);

    if (worldsName && storageName)
      return SourceDetector.fromGameRoot(dir, warnings);

    if (worldsName)
      return SourceDetector.fromWorldsDir(path.join(dir, worldsName), "worlds-dir", warnings);

    if ((await SourceDetector.looksLikeWorld(dir)).ok)
      return SourceDetector.fromBareWorld(dir, warnings);

    if (storageName && await SourceDetector.looksLikeStorageRoot(path.join(dir, storageName)))
      return SourceDetector.fromRecordsRoot(dir, path.join(dir, storageName), warnings);

    // The storage folder may also be the entry point itself, rather than a
    // child of the directory the user picked.
    if (await SourceDetector.looksLikeStorageRoot(dir))
      return SourceDetector.fromRecordsRoot(path.dirname(dir), dir, warnings);

    var children = await SourceDetector.scanChildren(dir, warnings);

    if (children.length === 1)
      return SourceDetector.fromBareWorld(children[0], warnings);

    if (children.length > 1) {
      return {
        kind: "multi-world",
        rootPath: dir,
        layout: null,
        isTemp: false,
        worlds: children.map(child => SourceDetector.worldCandidate(child)),
        warnings: warnings
      }
    }

    throw new Error(`Cannot recognise an import source at ${dir}`)
  }

  /**
   * Descend through a single wrapper folder, as left by many archivers.
   * @param {string} dir - Extraction directory.
   * @returns {Promise<string>} Directory holding the real contents.
   */
  static async unwrapSingleFolder(dir) {
    var current = dir;

    for (var depth = 0; depth < 4; depth++) {
      var entries = await Fsx.readdir(current);

      if (entries.length !== 1 || !entries[0].isDirectory())
        return current

      current = path.join(current, entries[0].name);
    }

    return current
  }

  /**
   * Read and validate an export manifest.
   * @param {string} dir - Directory that may hold a manifest.
   * @returns {Promise<object|null>}
   */
  static async readManifest(dir) {
    var manifest = await Fsx.readJsonLenient(path.join(dir, MANIFEST_NAME));

    if (manifest && manifest.format === MANIFEST_FORMAT)
      return manifest

    return null
  }

  /**
   * Score a directory as a candidate world folder.
   *
   * Scored rather than boolean so that a records directory or a per-user
   * folder, which share some filenames, cannot be mistaken for a world.
   * @param {string} dir - Directory to score.
   * @returns {Promise<{ok: boolean, score: number, signals: string[]}>}
   */
  static async looksLikeWorld(dir) {
    var signals = []
      , score = 0;

    if (await Fsx.existsFile(path.join(dir, "level.dat"))) {
      score += SCORE_LEVEL_DAT;
      signals.push("level.dat");
    }

    if (await Fsx.existsFile(path.join(dir, "levelname.txt"))) {
      score += SCORE_LEVELNAME;
      signals.push("levelname.txt");
    }

    var dbEntries = await Fsx.readdir(path.join(dir, "db"));

    if (dbEntries.some(e => e.isFile() && e.name === "CURRENT")) {
      score += SCORE_DB_CURRENT;
      signals.push("db/CURRENT");
    }

    if (dbEntries.some(e => e.isFile() && e.name.startsWith("MANIFEST-"))) {
      score += SCORE_DB_MANIFEST;
      signals.push("db/MANIFEST-*");
    }

    if (dbEntries.some(e => e.isFile() && e.name.endsWith(".ldb"))) {
      score += SCORE_DB_TABLE;
      signals.push("db/*.ldb");
    }

    return { ok: score >= WORLD_THRESHOLD, score: score, signals: signals }
  }

  /**
   * Score every immediate subdirectory as a world.
   * @param {string} dir - Parent directory.
   * @param {string[]} warnings - Warning sink.
   * @returns {Promise<string[]>} Paths that look like worlds.
   */
  static async scanChildren(dir, warnings) {
    var out = [];

    for (var name of await Fsx.listDirs(dir)) {
      var child = path.join(dir, name);

      if ((await SourceDetector.looksLikeWorld(child)).ok)
        out.push(child);

      await Fsx.yield();
    }

    return out
  }

  /**
   * Build a candidate for a world folder with no accompanying record.
   * @param {string} worldDir - World folder path.
   * @returns {object}
   */
  static worldCandidate(worldDir) {
    return {
      levelId: path.basename(worldDir),
      idSource: "folder-name",
      worldDir: worldDir,
      record: null,
      recordError: null,
      usersPresent: {},
      displayName: null,
      manifest: null
    }
  }

  /**
   * Build a source from one bare world folder.
   * @param {string} dir - World folder.
   * @param {string[]} warnings - Warning sink.
   * @returns {object}
   */
  static fromBareWorld(dir, warnings) {
    return {
      kind: "bare-world",
      rootPath: dir,
      layout: null,
      isTemp: false,
      worlds: [SourceDetector.worldCandidate(dir)],
      warnings: warnings
    }
  }

  /**
   * Build a source from a folder of world folders.
   * @param {string} worldsDir - Directory holding world folders.
   * @param {string} kind - Source kind to report.
   * @param {string[]} warnings - Warning sink.
   * @returns {Promise<object>}
   */
  static async fromWorldsDir(worldsDir, kind, warnings) {
    var names = await Fsx.listDirs(worldsDir)
      , worlds = names.map(name => SourceDetector.worldCandidate(path.join(worldsDir, name)));

    if (worlds.length === 0)
      warnings.push("no world folders were found");

    return {
      kind: kind,
      rootPath: worldsDir,
      layout: null,
      isTemp: false,
      worlds: worlds,
      warnings: warnings
    }
  }

  /**
   * Build a source from a complete game data root.
   * @param {string} root - Game data root.
   * @param {string[]} warnings - Warning sink.
   * @returns {Promise<object>}
   */
  static async fromGameRoot(root, warnings) {
    var layout = await GameLayout.resolve(root)
      , entries = await WorldRegistry.build(layout, { withMeta: false });

    // Reusing the registry keeps a root import and the world list agreeing on
    // what the four states mean.
    var worlds = entries.map(entry => ({
      levelId: entry.levelId,
      idSource: entry.worldDir ? "folder-name" : "record-filename",
      worldDir: entry.worldDir,
      record: entry.record,
      recordError: entry.recordError,
      usersPresent: entry.usersPresent,
      state: entry.state,
      displayName: entry.displayName,
      manifest: null
    }));

    return {
      kind: "game-root",
      rootPath: root,
      layout: layout,
      isTemp: false,
      worlds: worlds,
      warnings: warnings.concat(layout.warnings)
    }
  }

  /**
   * Test whether a directory is itself a storage root.
   * @param {string} dir - Directory to test.
   * @returns {Promise<boolean>}
   */
  static async looksLikeStorageRoot(dir) {
    var stream = path.join(dir, "stream");

    if (!(await Fsx.existsDir(stream)))
      return false

    // Either half is enough: a registry-only tree and a user-only tree are both
    // meaningful sources to import from.
    return (await Fsx.existsDir(path.join(stream, "resource_management")))
      || (await Fsx.existsDir(path.join(stream, "users")))
  }

  /**
   * Build a registry-only source from a storage folder with no world data.
   * @param {string} root - Directory to treat as the game root.
   * @param {string} storageDir - Path of the storage directory.
   * @param {string[]} warnings - Warning sink.
   * @returns {Promise<object>}
   */
  static async fromRecordsRoot(root, storageDir, warnings) {
    var layout = GameLayout.forStorage(root, storageDir)
      , records = await WorldRecord.list(layout);

    warnings.push("this source holds only the world registry, with no world data");

    var worlds = records.map(found => ({
      levelId: found.levelId,
      idSource: "record-filename",
      worldDir: null,
      record: found.record,
      recordError: found.error,
      usersPresent: {},
      displayName: null,
      manifest: null
    }));

    return {
      kind: "records-root",
      rootPath: root,
      layout: layout,
      isTemp: false,
      worlds: worlds,
      warnings: warnings
    }
  }

  /**
   * Build a source from one of our own export packages.
   * @param {string} dir - Package root.
   * @param {object} manifest - Parsed manifest.
   * @param {string[]} warnings - Warning sink.
   * @returns {Promise<object>}
   */
  static async fromManifest(dir, manifest, warnings) {
    var worlds = [];

    if (!Array.isArray(manifest.worlds) || manifest.worlds.length === 0)
      warnings.push("the package manifest lists no worlds");

    for (var item of manifest.worlds || []) {
      var id = item.levelId
        , worldRel = item.worldPath || `${PACKAGE_WORLDS}/${id}`
        , worldDir = path.join(dir, worldRel)
        , recordRel = item.recordPath || `${PACKAGE_RECORDS}/${id}.json`
        , recordFile = path.join(dir, recordRel)
        , usersPresent = {};

      // Every path a manifest supplies is confined to the package. A crafted
      // manifest must not be able to aim the import at a directory elsewhere on
      // the disk, and a package may legitimately have been pruned in transit,
      // so presence is confirmed rather than trusted either way.
      if (!Fsx.isInside(dir, worldDir)) {
        warnings.push(`ignored a world path outside the package: ${worldRel}`);
        worldDir = null;
      } else if (!(await Fsx.existsDir(worldDir)))
        worldDir = null;

      if (!Fsx.isInside(dir, recordFile)) {
        warnings.push(`ignored a record path outside the package: ${recordRel}`);
        recordFile = null;
      }

      var record = recordFile ? await Fsx.readJsonLenient(recordFile) : null;

      for (var user of item.users || []) {
        var userDir = user.path
          ? path.join(dir, user.path)
          : path.join(dir, PACKAGE_USERS, user.uid, id);

        if (Fsx.isInside(dir, userDir) && await Fsx.existsDir(userDir))
          usersPresent[user.uid] = userDir;
      }

      if (!worldDir && item.worldPresent)
        warnings.push(`world data is missing from the package: ${id}`);

      worlds.push({
        levelId: id,
        idSource: "manifest",
        worldDir: worldDir,
        record: record,
        recordError: null,
        usersPresent: usersPresent,
        displayName: item.displayName || null,
        manifest: item
      });
    }

    return {
      kind: "managed-export",
      rootPath: dir,
      layout: null,
      isTemp: false,
      manifest: manifest,
      worlds: worlds,
      warnings: warnings
    }
  }
}

module.exports = SourceDetector;
