const path = require("path");

const Fsx = require("../os/fsx");
const LevelDat = require("../os/leveldat");
const XorEnc = require("../os/xorenc");

const MANIFEST_RE = /^MANIFEST-\d{6,}$/;
const TABLE_RE = /\.ldb$/i;

// Errors make a world unusable: the client cannot open it, or cannot find the
// data it needs. Warnings mark a world that still opens but has lost something
// worth knowing about.
const ERROR = "error";
const WARN = "warn";

// level.dat is read to prove it parses, and a corrupt one is not worth reading
// past this size. Real files are a few kilobytes.
const LEVEL_DAT_MAX = 8 * 1024 * 1024;

class WorldIntegrity {
  /**
   * Check the files a world needs, in the order the client needs them.
   *
   * A world folder can be present, registered, and still be unusable: the
   * registry says nothing about whether db/CURRENT survived a copy. This reads
   * the folder itself and reports what is missing or broken.
   * @param {string} worldDir - Path of the world folder.
   * @returns {Promise<object>} Integrity report.
   */
  static async check(worldDir) {
    var problems = []
      , present = {
          levelDat: false,
          levelDatBytes: 0,
          levelDatOld: false,
          levelNameTxt: false,
          db: false,
          current: false,
          manifest: null,
          tables: 0,
          logs: 0
        };

    // --- level.dat -------------------------------------------------------
    var levelDatPath = path.join(worldDir, "level.dat")
      , levelDat = await Fsx.readBufferLenient(levelDatPath);

    if (levelDat === null) {
      problems.push({
        code: "ELEVELDAT",
        level: ERROR,
        message: "缺少 level.dat，客户端无法识别该存档"
      });
    } else {
      present.levelDat = true;
      present.levelDatBytes = levelDat.length;

      if (levelDat.length === 0)
        problems.push({ code: "ELEVELDAT_EMPTY", level: ERROR, message: "level.dat 为空文件" });
      else if (levelDat.length > LEVEL_DAT_MAX)
        problems.push({
          code: "WLEVELDAT_LARGE",
          level: WARN,
          message: `level.dat 有 ${levelDat.length} 字节，异常偏大`
        });
      else if (LevelDat.parse(levelDat) === null)
        problems.push({
          code: "ELEVELDAT_BAD",
          level: ERROR,
          message: "level.dat 无法解析：文件头或 NBT 数据已损坏"
        });
    }

    present.levelDatOld = await Fsx.existsFile(path.join(worldDir, "level.dat_old"));

    if (present.levelDat && !present.levelDatOld)
      problems.push({
        code: "WLEVELDAT_OLD",
        level: WARN,
        message: "缺少 level.dat_old，没有可回退的上一次存档"
      });

    present.levelNameTxt = await Fsx.existsFile(path.join(worldDir, "levelname.txt"));

    if (!present.levelNameTxt)
      problems.push({
        code: "WLEVELNAME",
        level: WARN,
        message: "缺少 levelname.txt，存档名只能从 level.dat 读取"
      });

    // --- db/ -------------------------------------------------------------
    var dbDir = path.join(worldDir, "db");

    if (!(await Fsx.existsDir(dbDir))) {
      problems.push({
        code: "EDB",
        level: ERROR,
        message: "缺少 db 文件夹，存档没有方块数据"
      });

      return WorldIntegrity.report(worldDir, present, problems, null)
    }

    present.db = true;

    var entries = await Fsx.readdir(dbDir)
      , manifests = [];

    for (var entry of entries) {
      if (!entry.isFile())
        continue

      if (MANIFEST_RE.test(entry.name)) {
        manifests.push(entry.name);
        present.manifest = entry.name;
      } else if (entry.name === "CURRENT") {
        present.current = true;
      } else if (TABLE_RE.test(entry.name)) {
        present.tables++;
      } else if (/\.log$/i.test(entry.name)) {
        present.logs++;
      }
    }

    if (!present.current)
      problems.push({
        code: "ECURRENT",
        level: ERROR,
        message: "缺少 db/CURRENT，客户端无法定位数据库清单"
      });

    if (manifests.length === 0)
      problems.push({
        code: "EMANIFEST",
        level: ERROR,
        message: "缺少 db/MANIFEST-*，数据库清单丢失"
      });

    if (present.tables === 0)
      problems.push({
        code: "WTABLES",
        level: WARN,
        message: present.logs > 0
          ? "没有 .ldb 表文件，数据仍留在 .log 中尚未整理"
          : "没有 .ldb 表文件，数据库可能是空的"
      });

    // --- what CURRENT points at ------------------------------------------
    var current = present.current
      ? await WorldIntegrity.readCurrent(dbDir)
      : { name: null, readable: false, encrypted: false };

    // CURRENT holds the name of the manifest the database is using. Pointing at
    // one that is not there is a silent corruption the file listing alone
    // cannot reveal.
    if (current.name && manifests.length > 0 && !manifests.includes(current.name))
      problems.push({
        code: "ECURRENT_DANGLING",
        level: ERROR,
        message: `db/CURRENT 指向 ${current.name}，但该文件不存在`
      });

    if (present.current && !current.readable)
      problems.push({
        code: "WCURRENT_UNREADABLE",
        level: WARN,
        message: current.encrypted
          ? "db/CURRENT 已加密且无法推断密钥，未能核对它指向的清单"
          : "db/CURRENT 内容无法识别为清单名"
      });

    return WorldIntegrity.report(worldDir, present, problems, current)
  }

  /**
   * Read the manifest name db/CURRENT points at.
   *
   * The database is often encrypted, in which case the key is inferred the same
   * way an export infers it.
   * @param {string} dbDir - Path of the db folder.
   * @returns {Promise<{name: string|null, readable: boolean, encrypted: boolean}>}
   */
  static async readCurrent(dbDir) {
    var buf = await Fsx.readBufferLenient(path.join(dbDir, "CURRENT"));

    if (buf === null || buf.length === 0)
      return { name: null, readable: false, encrypted: false }

    if (!XorEnc.isEncrypted(buf))
      return WorldIntegrity.parseName(buf, false)

    var inferred = await XorEnc.inferKey(dbDir)
      , plain = XorEnc.decrypt(buf, inferred ? inferred.key : XorEnc.defaultKey());

    if (plain === null)
      return { name: null, readable: false, encrypted: true }

    return WorldIntegrity.parseName(plain, true)
  }

  /**
   * Turn a decrypted CURRENT into the file name it holds.
   * @param {Buffer} buf - Decrypted contents.
   * @param {boolean} encrypted - Whether the file was encrypted.
   * @returns {{name: string|null, readable: boolean, encrypted: boolean}}
   */
  static parseName(buf, encrypted) {
    var text = buf.toString("utf8").replace(/\0+$/, "").trim();

    if (!MANIFEST_RE.test(text))
      return { name: null, readable: false, encrypted: encrypted }

    return { name: text, readable: true, encrypted: encrypted }
  }

  /**
   * Assemble the report.
   * @param {string} worldDir - Path of the world folder.
   * @param {object} present - What was found.
   * @param {object[]} problems - Collected problems.
   * @param {object|null} current - What CURRENT pointed at.
   * @returns {object}
   */
  static report(worldDir, present, problems, current) {
    var errors = problems.filter(p => p.level === ERROR)
      , warnings = problems.filter(p => p.level === WARN);

    return {
      worldDir: worldDir,
      ok: errors.length === 0,
      problems: problems,
      errors: errors,
      warnings: warnings,
      present: present,
      current: current
    }
  }

  /**
   * Summarise a report in one line, for a list row or a status bar.
   * @param {object|null} report - Integrity report.
   * @returns {string}
   */
  static summarize(report) {
    if (!report)
      return "未检查"

    if (report.problems.length === 0)
      return "完整"

    var parts = [];

    if (report.errors.length > 0)
      parts.push(`${report.errors.length} 项错误`);

    if (report.warnings.length > 0)
      parts.push(`${report.warnings.length} 项警告`);

    return parts.join(" · ")
  }
}

module.exports = WorldIntegrity;
