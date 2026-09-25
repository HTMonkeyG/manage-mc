const path = require("path");

const Fsx = require("./fsx");

// Zip entries always use forward slashes, and a trailing slash marks a
// directory entry.
const ZIP_SEPARATOR = "/";

/**
 * Load adm-zip, which is an optional dependency.
 *
 * Folder export works without it, so the failure is deferred until a zip is
 * actually requested rather than blocking startup.
 * @returns {Function} The adm-zip constructor.
 */
function loadAdmZip() {
  try {
    return require("adm-zip")
  } catch (e) {
    var err = new Error("Zip support needs the adm-zip package. Install it with: npm install adm-zip");
    err.code = "ENOZIP";
    throw err
  }
}

class Pack {
  /**
   * Report whether zip support is available.
   * @returns {boolean}
   */
  static available() {
    try {
      require.resolve("adm-zip");
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Pack a directory into a zip archive.
   *
   * Empty directories are written explicitly: adm-zip's folder helper drops
   * them, and a per-user world folder is frequently empty, so relying on it
   * would silently lose part of the package.
   * @param {string} srcDir - Directory to pack.
   * @param {string} zipPath - Archive to create.
   * @param {object} [opts] - Options.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @returns {Promise<{files: number, bytes: number, entries: number, warnings: string[], aborted: boolean}>}
   */
  static async zipDirectory(srcDir, zipPath, opts) {
    var options = opts || {}
      , AdmZip = loadAdmZip()
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

      if (entry.dir)
        zip.addFile(name + ZIP_SEPARATOR, Buffer.alloc(0));
      else
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

    // Only newer adm-zip releases expose the promise form of writeZip.
    if (typeof zip.writeZipPromise === "function")
      await zip.writeZipPromise(zipPath, { overwrite: true });
    else
      zip.writeZip(zipPath);

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
    var AdmZip = loadAdmZip()
      , warnings = []
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
