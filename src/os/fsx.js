const fsp = require("fs/promises")
  , fs = require("fs")
  , path = require("path")
  , { pipeline } = require("stream/promises");

// Files at or above this size are streamed instead of copied in one call, so a
// multi-hundred-megabyte LevelDB table is never buffered whole.
const STREAM_THRESHOLD = 32 * 1024 * 1024;

// Transient Windows failures. Antivirus and the indexer hold handles for a few
// hundred milliseconds after a write, so retrying is worth it before giving up.
const RETRY_CODES = ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"];
const RETRY_DELAYS = [100, 300, 900];

class Fsx {
  /**
   * Run an async operation, retrying transient Windows filesystem failures.
   * @param {function(): Promise<any>} fn - Operation to run.
   * @returns {Promise<any>} Result of the operation.
   */
  static async retry(fn) {
    var last;

    for (var i = 0; i <= RETRY_DELAYS.length; i++) {
      try {
        return await fn()
      } catch (e) {
        last = e;
        if (!RETRY_CODES.includes(e.code) || i === RETRY_DELAYS.length)
          throw e
        await Fsx.sleep(RETRY_DELAYS[i]);
      }
    }

    throw last
  }

  /**
   * Sleep for a number of milliseconds.
   * @param {number} ms - Duration.
   * @returns {Promise<void>}
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Yield to the event loop so the renderer keeps repainting.
   * @returns {Promise<void>}
   */
  static yield() {
    return new Promise(setImmediate)
  }

  /**
   * Test whether a path exists.
   * @param {string} target - Path to test.
   * @returns {Promise<boolean>}
   */
  static async exists(target) {
    try {
      await fsp.access(target);
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Test whether a path is an existing directory.
   * @param {string} target - Path to test.
   * @returns {Promise<boolean>}
   */
  static async existsDir(target) {
    try {
      return (await fsp.stat(target)).isDirectory()
    } catch (e) {
      return false
    }
  }

  /**
   * Test whether a path is an existing regular file.
   * @param {string} target - Path to test.
   * @returns {Promise<boolean>}
   */
  static async existsFile(target) {
    try {
      return (await fsp.stat(target)).isFile()
    } catch (e) {
      return false
    }
  }

  /**
   * Test whether a path is a symlink or a Windows junction.
   *
   * Reparse points are refused rather than followed, because a hostile level id
   * or user id must not be able to redirect a write outside the game root.
   * @param {string} target - Path to test.
   * @returns {Promise<boolean>}
   */
  static async isReparsePoint(target) {
    try {
      return (await fsp.lstat(target)).isSymbolicLink()
    } catch (e) {
      return false
    }
  }

  /**
   * Create a directory and every missing parent.
   * @param {string} target - Directory to create.
   * @returns {Promise<void>}
   */
  static async mkdirp(target) {
    await fsp.mkdir(target, { recursive: true });
  }

  /**
   * List directory entries, returning an empty array when absent.
   * @param {string} target - Directory to read.
   * @returns {Promise<import("fs").Dirent[]>}
   */
  static async readdir(target) {
    try {
      return await fsp.readdir(target, { withFileTypes: true })
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR")
        return []
      throw e
    }
  }

  /**
   * List only the subdirectory names of a directory.
   * @param {string} target - Directory to read.
   * @returns {Promise<string[]>}
   */
  static async listDirs(target) {
    var entries = await Fsx.readdir(target);
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  }

  /**
   * Read a text file, tolerating absence and stripping a UTF-8 BOM.
   * @param {string} file - File to read.
   * @returns {Promise<string|null>} File contents, or null when absent.
   */
  static async readTextLenient(file) {
    var buf;

    try {
      buf = await fsp.readFile(file);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR")
        return null
      throw e
    }

    // Some client-written files carry a BOM, which JSON.parse rejects.
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
      buf = buf.subarray(3);

    return buf.toString("utf8")
  }

  /**
   * Read and parse a JSON file.
   * @param {string} file - File to read.
   * @returns {Promise<object|null>} Parsed value, or null when absent.
   * @throws {Error} With code EJSONPARSE when the file is not valid JSON.
   */
  static async readJsonLenient(file) {
    var text = await Fsx.readTextLenient(file);

    if (text === null)
      return null

    try {
      return JSON.parse(text)
    } catch (e) {
      var err = new Error(`Malformed JSON in ${file}: ${e.message}`);
      err.code = "EJSONPARSE";
      err.file = file;
      throw err
    }
  }

  /**
   * Write a file atomically: temp file, flush, then rename over the target.
   * @param {string} file - Destination path.
   * @param {Buffer|string} data - Contents to write.
   * @param {string} [encoding] - Encoding used when data is a string.
   * @returns {Promise<void>}
   */
  static async atomicWriteBuffer(file, data, encoding) {
    var tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      , handle;

    await Fsx.mkdirp(path.dirname(file));

    try {
      handle = await fsp.open(tmp, "w");
      await handle.writeFile(data, encoding);
      // Flush before the rename, so a crash cannot publish a truncated file.
      await handle.sync();
    } finally {
      if (handle)
        await handle.close();
    }

    try {
      await Fsx.retry(() => fsp.rename(tmp, file));
    } catch (e) {
      await Fsx.remove(tmp);
      throw e
    }
  }

  /**
   * Write a text file atomically.
   * @param {string} file - Destination path.
   * @param {string} text - Contents to write.
   * @returns {Promise<void>}
   */
  static async atomicWriteText(file, text) {
    await Fsx.atomicWriteBuffer(file, text, "utf8");
  }

  /**
   * Serialize a value as single-line JSON and write it atomically.
   * @param {string} file - Destination path.
   * @param {any} value - Value to serialize.
   * @returns {Promise<void>}
   */
  static async atomicWriteJson(file, value) {
    await Fsx.atomicWriteText(file, JSON.stringify(value));
  }

  /**
   * Walk a directory tree and collect every regular file and directory.
   * @param {string} root - Directory to walk.
   * The longest single component is reported alongside the longest relative
   * path, because NTFS limits a component to 255 UTF-16 code units while the
   * whole path is limited separately.
   * @param {string} root - Directory to walk.
   * @param {object} [opts] - Options.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @returns {Promise<{entries: object[], files: number, bytes: number, maxRelLen: number, maxNameLen: number, aborted: boolean}>}
   */
  static async walkTree(root, opts) {
    var signal = (opts || {}).signal
      , entries = []
      , queue = [{ abs: root, rel: "" }]
      , files = 0
      , bytes = 0
      , maxRelLen = 0
      , maxNameLen = 0;

    while (queue.length > 0) {
      if (signal && signal.aborted)
        return { entries, files, bytes, maxRelLen, maxNameLen, aborted: true }

      var current = queue.shift()
        , children = await Fsx.readdir(current.abs);

      for (var child of children) {
        var rel = current.rel === "" ? child.name : `${current.rel}/${child.name}`
          , abs = path.join(current.abs, child.name);

        if (child.isDirectory()) {
          entries.push({ abs, rel, dir: true, size: 0 });
          queue.push({ abs, rel });
        } else if (child.isFile()) {
          var size = (await fsp.stat(abs)).size;
          entries.push({ abs, rel, dir: false, size });
          files++;
          bytes += size;
        } else
          // Symlinks, junctions and devices are deliberately skipped rather
          // than copied through, so a reparse point cannot smuggle data in.
          continue

        if (rel.length > maxRelLen)
          maxRelLen = rel.length;

        if (child.name.length > maxNameLen)
          maxNameLen = child.name.length;
      }

      await Fsx.yield();
    }

    return { entries, files, bytes, maxRelLen, maxNameLen, aborted: false }
  }

  /**
   * Measure the size of a directory tree.
   * @param {string} root - Directory to measure.
   * @returns {Promise<{files: number, bytes: number}>}
   */
  static async du(root) {
    var walk = await Fsx.walkTree(root, {});
    return { files: walk.files, bytes: walk.bytes }
  }

  /**
   * Copy a single file, streaming inputs at or above the threshold.
   * @param {string} src - Source file.
   * @param {string} dst - Destination file.
   * @param {number} size - Known size of the source in bytes.
   * @returns {Promise<void>}
   */
  static async copyFile(src, dst, size) {
    if (size < STREAM_THRESHOLD) {
      await Fsx.retry(() => fsp.copyFile(src, dst));
      return
    }

    await Fsx.retry(() => pipeline(fs.createReadStream(src), fs.createWriteStream(dst)));
  }

  /**
   * Copy a directory tree, reporting progress as it goes.
   * @param {string} src - Source directory.
   * @param {string} dst - Destination directory.
   * @param {object} [opts] - Options.
   * @param {AbortSignal} [opts.signal] - Cancellation signal.
   * @param {function(object): void} [opts.onProgress] - Progress callback.
   * @param {number} [opts.throttleMs] - Minimum interval between callbacks.
   * @returns {Promise<{files: number, bytes: number, aborted: boolean}>}
   */
  static async copyTree(src, dst, opts) {
    var options = opts || {}
      , signal = options.signal
      , onProgress = options.onProgress
      , throttle = options.throttleMs === undefined ? 100 : options.throttleMs
      , started = Date.now()
      , lastTick = 0
      , done = { files: 0, bytes: 0 };

    // The walk supplies the denominator, so progress is a real percentage
    // rather than a spinner on a multi-minute copy.
    var walk = await Fsx.walkTree(src, { signal });

    if (walk.aborted)
      return { files: 0, bytes: 0, aborted: true }

    var report = (currentPath, force) => {
      if (!onProgress)
        return

      var now = Date.now();
      if (!force && now - lastTick < throttle)
        return

      lastTick = now;

      var elapsed = now - started
        , ratio = walk.bytes > 0 ? done.bytes / walk.bytes : 1;

      onProgress({
        files: done.files,
        filesTotal: walk.files,
        bytes: done.bytes,
        bytesTotal: walk.bytes,
        currentPath: currentPath,
        elapsedMs: elapsed,
        etaMs: ratio > 0 && ratio < 1 ? Math.round(elapsed / ratio - elapsed) : 0
      });
    };

    await Fsx.mkdirp(dst);

    for (var entry of walk.entries) {
      if (signal && signal.aborted)
        return { files: done.files, bytes: done.bytes, aborted: true }

      var target = path.join(dst, entry.rel);

      if (entry.dir) {
        await Fsx.mkdirp(target);
        continue
      }

      await Fsx.mkdirp(path.dirname(target));
      await Fsx.copyFile(entry.abs, target, entry.size);
      done.files++;
      done.bytes += entry.size;
      report(entry.rel, false);
    }

    report("", true);

    return { files: done.files, bytes: done.bytes, aborted: false }
  }

  /**
   * Move a path aside instead of deleting it, so a botched operation is
   * recoverable by hand.
   * @param {string} target - Path to move aside.
   * @returns {Promise<string|null>} New path, or null when the target is absent.
   */
  static async renameAside(target) {
    if (!(await Fsx.exists(target)))
      return null

    var aside = `${target}.bak-${Fsx.stamp()}`;
    await Fsx.retry(() => fsp.rename(target, aside));
    return aside
  }

  /**
   * Delete a path recursively, clearing read-only attributes on Windows.
   * @param {string} target - Path to delete.
   * @returns {Promise<void>}
   */
  static async remove(target) {
    try {
      await Fsx.retry(() => fsp.rm(target, { recursive: true, force: true }));
    } catch (e) {
      if (e.code !== "EPERM" && e.code !== "EACCES")
        throw e
      // A read-only attribute copied from a source tree blocks recursive
      // removal; clear it and try once more.
      await Fsx.clearReadonly(target);
      await fsp.rm(target, { recursive: true, force: true });
    }
  }

  /**
   * Clear the read-only attribute on a path and everything below it.
   * @param {string} target - Path to process.
   * @returns {Promise<void>}
   */
  static async clearReadonly(target) {
    var stat;

    try {
      stat = await fsp.lstat(target);
    } catch (e) {
      return
    }

    if (stat.isDirectory()) {
      for (var name of await fsp.readdir(target))
        await Fsx.clearReadonly(path.join(target, name));
    }

    try {
      await fsp.chmod(target, 0o666);
    } catch (e) {
      // chmod is a no-op on some Windows filesystems; nothing to recover.
    }
  }

  /**
   * Report the free space available on the volume holding a path.
   * @param {string} target - Path on the volume to query.
   * @returns {Promise<number>} Free bytes.
   */
  static async freeSpace(target) {
    var stat = await fsp.statfs(target);
    return stat.bsize * stat.bavail
  }

  /**
   * Test that two paths live on the same volume.
   *
   * A rename is only atomic within one volume; across volumes it degrades to a
   * copy, which would break the staged publish.
   * @param {string} a - First path.
   * @param {string} b - Second path.
   * @returns {boolean}
   */
  static sameVolume(a, b) {
    return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase()
  }

  /**
   * Format a path as an absolute path with forward slashes.
   * @param {string} target - Path to convert.
   * @returns {string}
   */
  static toPosix(target) {
    return path.resolve(target).split(path.sep).join("/")
  }

  /**
   * Test whether a path is strictly inside a parent directory.
   * @param {string} parent - Directory expected to contain the child.
   * @param {string} child - Path to test.
   * @returns {boolean}
   */
  static isInside(parent, child) {
    var rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  }

  /**
   * Build a filesystem-safe timestamp.
   * @returns {string} Timestamp formatted as yyyyMMdd-HHmmss.
   */
  static stamp() {
    var d = new Date()
      , pad = n => String(n).padStart(2, "0");

    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  /**
   * Render a byte count for display.
   * @param {number} bytes - Size in bytes.
   * @returns {string} Human readable size.
   */
  static humanSize(bytes) {
    var units = ["B", "KB", "MB", "GB", "TB"]
      , value = bytes
      , unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }

    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
  }
}

module.exports = Fsx;
