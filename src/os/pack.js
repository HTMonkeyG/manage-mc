const path = require("path");

const AdmZip = require("adm-zip");

const Fsx = require("./fsx");

// Zip entries always use forward slashes, and a trailing slash marks a
// directory entry.
const ZIP_SEPARATOR = "/";

class Pack {
  /**
   * Pack a directory into a zip archive.
   *
   * Entries are added one at a time from a walk rather than through
   * addLocalFolder, because that helper drops empty directories and a per-user
   * world folder is frequently empty. addLocalFile is used for files and
   * directories alike: it appends the trailing separator for a directory and
   * carries the modification time across.
   * @param {string} srcDir - Directory to pack.
   * @param {string} zipPath - Archive to create.
   * @param {object} [opts] - Options.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @returns {Promise<{files: number, bytes: number, entries: number, warnings: string[], aborted: boolean}>}
   */
  static async zipDirectory(srcDir, zipPath, opts) {
    var options = opts || {}
      , warnings = []
      , zip = new AdmZip()
      , walk = await Fsx.walkTree(srcDir, { signal: options.signal });

    if (walk.aborted)
      return { files: 0, bytes: 0, entries: 0, warnings: warnings, aborted: true }

    var started = Date.now()
      , done = 0;

    for (var entry of walk.entries) {
      if (options.signal && options.signal.aborted)
        return { files: 0, bytes: 0, entries: 0, warnings: warnings, aborted: true }

      var name = entry.rel.split("/").join(ZIP_SEPARATOR)
        , folder = path.posix.dirname(name);

      zip.addLocalFile(entry.abs, folder === "." ? "" : folder, path.posix.basename(name));

      done++;

      if (options.onProgress)
        options.onProgress({
          files: done,
          filesTotal: walk.entries.length,
          bytes: entry.size,
          bytesTotal: walk.bytes,
          currentPath: entry.rel,
          elapsedMs: Date.now() - started,
          etaMs: 0
        });
    }

    // A replacement character in an entry name means the name did not survive
    // encoding, which would produce mojibake folder names on extraction.
    for (var written of zip.getEntries())
      if (written.entryName.includes("�"))
        warnings.push(`entry name is not valid UTF-8: ${written.entryName}`);

    await Fsx.mkdirp(path.dirname(zipPath));
    await zip.writeZipPromise(zipPath, { overwrite: true });

    return {
      files: walk.files,
      bytes: walk.bytes,
      entries: zip.getEntries().length,
      warnings: warnings,
      aborted: false
    }
  }

  /**
   * Extract a zip archive into a directory.
   *
   * Every entry is checked to stay inside the destination, so a hostile archive
   * cannot write through an absolute path or a ".." segment.
   * @param {string} zipPath - Archive to read.
   * @param {string} destDir - Directory to extract into.
   * @returns {Promise<{entries: number, warnings: string[]}>}
   */
  static async unzipTo(zipPath, destDir) {
    var warnings = []
      , zip = new AdmZip(zipPath)
      , root = path.resolve(destDir);

    await Fsx.mkdirp(root);

    for (var entry of zip.getEntries()) {
      var target = path.resolve(root, entry.entryName);

      if (target !== root && !Fsx.isInside(root, target)) {
        warnings.push(`skipped unsafe archive entry: ${entry.entryName}`);
        continue
      }

      if (entry.isDirectory) {
        await Fsx.mkdirp(target);
        continue
      }

      await Fsx.mkdirp(path.dirname(target));
      await Fsx.atomicWriteBuffer(target, entry.getData());
    }

    return { entries: zip.getEntries().length, warnings: warnings }
  }
}

module.exports = Pack;
