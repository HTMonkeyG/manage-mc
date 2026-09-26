const path = require("path");

const { ScrollView, Key, matchesKey } = require("@earendil-works/pi-tui");

const Fsx = require("../../os/fsx");
const XorEnc = require("../../os/xorenc");
const LevelId = require("../../records/levelid");
const WorldIntegrity = require("../../records/integrity");
const WorldRecord = require("../../records/record");
const WorldRegistry = require("../../records/registry");
const Theme = require("../theme");
const InfoPanel = require("../components/infoPanel");

// Record fields worth showing, in the order the client writes them.
const RECORD_FIELDS = [
  ["name", "显示名"],
  ["item_id", "item_id"],
  ["second_type", "second_type"],
  ["is_local", "is_local"],
  ["is_copy", "is_copy"],
  ["path", "path"],
  ["icon", "icon"],
  ["slogan", "标语"],
  ["max_member_size", "人数上限"],
  ["is_hardcore", "极限模式"],
  ["mod_version", "mod_version"],
  ["version", "version"]
];

class WorldDetailScreen {
  /**
   * Detail screen for one world.
   * @param {object} entry - World entry.
   */
  constructor(entry) {
    this.entry = entry;
    this.panel = new InfoPanel();
    this.scroll = null;
    this.dbState = null;
    this.integrity = null;
  }

  /**
   * Read the encryption state of a world's database, inferring the key when it
   * is encrypted.
   *
   * Only magic numbers and the small CURRENT file are read, plus one table for
   * verification, so this stays cheap on a large world.
   * @param {object} entry - World entry.
   * @returns {Promise<object|null>} Database state, or null when there is no db.
   */
  static async inspectDatabase(entry) {
    if (!entry.worldDir)
      return null

    var dbDir = path.join(entry.worldDir, "db");

    if (!(await Fsx.existsDir(dbDir)))
      return null

    var view = await XorEnc.inspect(dbDir);

    if (!view.isEncrypted)
      return Object.assign({ key: null, verified: null }, view);

    var inferred = await XorEnc.inferKey(dbDir);

    return Object.assign({
      key: inferred ? inferred.key : null,
      verified: inferred ? inferred.verified : null
    }, view);
  }

  /**
   * Screen title.
   * @returns {string}
   */
  title() {
    return Theme.plain(this.entry.displayName) || this.entry.levelId
  }

  /**
   * Screen subtitle.
   * @returns {string}
   */
  subtitle() {
    return `${this.entry.levelId} · ${Theme.stateLabel(this.entry.state)}`
  }

  /**
   * Key hint.
   * @returns {string}
   */
  hint() {
    var base = "↑↓ 滚动 · e 导出 · b/Esc/Ctrl+C 返回";

    return this.entry.state === "unregistered" ? `p 登记 · ${base}` : base
  }

  /**
   * The detail view is read only, so nothing holds focus.
   * @returns {null}
   */
  focus() {
    return null
  }

  /**
   * Build the screen.
   * @param {object} app - Application shell.
   * @returns {Promise<object>} Component to mount.
   */
  async mount(app) {
    this.app = app;

    // The detail panel is the one place a ScrollView is appropriate: the list
    // screens own their own scrolling window and must not be nested in one.
    this.scroll = new ScrollView(this.panel, {
      primary: true,
      follow: "none",
      scrollbar: "auto"
    });

    this.panel.setRows(this.buildRows());

    this.load(app);

    return this.scroll
  }

  /**
   * Load the metadata and size that are not part of the list view.
   * @param {object} app - Application shell.
   * @returns {Promise<void>}
   */
  async load(app) {
    var entry = this.entry;

    try {
      if (entry.worldDir && !entry.levelMeta)
        await WorldRegistry.loadMeta(entry);

      if (entry.worldDir && !entry.size)
        await WorldRegistry.measure(entry);

      if (entry.worldDir && !this.dbState)
        this.dbState = await WorldDetailScreen.inspectDatabase(entry);

      if (entry.worldDir && !this.integrity)
        this.integrity = await WorldIntegrity.check(entry.worldDir);

      this.panel.setRows(this.buildRows());
      app.tui.requestRender();
    } catch (e) {
      app.setStatus(`读取详情失败：${e.message}`, "error");
    }
  }

  /**
   * Build the rows shown in the panel.
   * @returns {object[]}
   */
  buildRows() {
    var entry = this.entry
      , rows = [];

    rows.push({ section: "基本信息" });
    rows.push({ key: "名称", value: Theme.plain(entry.displayName) });
    rows.push({ key: "level_id", value: entry.levelId });
    rows.push({ key: "id 形态", value: LevelId.describe(entry.levelId) });
    rows.push({ key: "状态", value: Theme.badge(entry.state) });
    rows.push({ key: "世界目录", value: entry.worldDir || Theme.chalk.dim("（不存在）") });
    rows.push({ key: "注册表", value: entry.recordFile || Theme.chalk.dim("（无记录）") });

    rows.push({
      key: "大小",
      value: entry.size
        ? `${Theme.size(entry.size.bytes)} · ${entry.size.files} 个文件`
        : (entry.worldDir ? Theme.chalk.dim("统计中…") : Theme.chalk.dim("—"))
    });

    // level.dat holds the real figure; the account timestamps are only a lower
    // bound, so which one answered is worth saying.
    var fromLevelDat = Boolean(entry.levelMeta && entry.levelMeta.lastPlayed);

    rows.push({
      key: "最近游玩",
      value: entry.lastPlayed
        ? `${Theme.time(entry.lastPlayed)}${fromLevelDat ? "" : Theme.chalk.dim("（据账号记录，非精确值）")}`
        : Theme.chalk.dim("—")
    });

    if (this.integrity)
      rows.push(...this.integrityRows());

    if (this.dbState)
      rows.push(...this.databaseRows());

    if (entry.record)
      rows.push(...this.recordRows(entry.record));

    if (entry.levelMeta)
      rows.push(...this.metaRows(entry.levelMeta));

    rows.push(...this.userRows());

    if (entry.anomalies.length > 0) {
      rows.push({ section: "异常" });

      for (var anomaly of entry.anomalies)
        rows.push({ text: Theme.chalk.yellow(`  ! ${anomaly}`) });
    }

    if (entry.state !== "registered") {
      rows.push({ section: "状态说明" });
      rows.push({ text: `  ${Theme.stateHint(entry.state)}` });
    }

    return rows
  }

  /**
   * Colour a required file's name by whether it is present.
   * @param {string} name - File or folder name to show.
   * @param {boolean} present - Whether it was found.
   * @returns {string} The name, in bold green or bold red.
   */
  static markFile(name, present) {
    var chalk = Theme.chalk;

    return present ? chalk.green.bold(name) : chalk.red.bold(name)
  }

  /**
   * Rows describing whether the world's own files are all present.
   * @returns {object[]}
   */
  integrityRows() {
    var report = this.integrity
      , chalk = Theme.chalk
      , rows = [{ section: "完整性" }];

    rows.push({
      key: "结论",
      value: report.ok
        ? (report.warnings.length > 0 ? chalk.yellow(`可用，但有 ${report.warnings.length} 项警告`) : chalk.green("完整"))
        : chalk.red(`缺少或损坏 ${report.errors.length} 项必需文件`)
    });

    var present = report.present;

    // The name carries the verdict: green when the file is there, red when it
    // is not, so the row reads at a glance without a separate 有/无 column.
    rows.push({
      key: "必需文件",
      value: [
        WorldDetailScreen.markFile("level.dat", present.levelDat),
        WorldDetailScreen.markFile("db/", present.db),
        WorldDetailScreen.markFile("CURRENT", present.current),
        WorldDetailScreen.markFile("MANIFEST-*", Boolean(present.manifest))
      ].join(chalk.dim(" · "))
    });

    // Counts rather than presence, so they stay neutral: a file type with none
    // of its files is reported in the problem list instead.
    if (present.db)
      rows.push({
        key: "数据库内容",
        value: [
          chalk.white.bold(`.ldb: ${present.tables}`),
          chalk.white.bold(`.log: ${present.logs}`)
        ].join(chalk.dim(" · "))
      });

    if (report.current && report.current.name)
      rows.push({ key: "CURRENT 指向", value: report.current.name });

    if (report.problems.length === 0) {
      rows.push({ text: chalk.dim("  该存档所需的文件齐全。") });
      return rows
    }

    for (var problem of report.problems)
      rows.push({
        text: problem.level === "error"
          ? chalk.red(`  ! ${problem.message}`)
          : chalk.yellow(`  · ${problem.message}`)
      });

    if (!report.ok) {
      rows.push({ text: "" });
      rows.push({ text: chalk.dim("  缺少必需文件的存档客户端无法打开。导出仍会进行，") });
      rows.push({ text: chalk.dim("  但得到的包同样是损坏的。") });
    }

    return rows
  }

  /**
   * Rows describing the database encryption.
   * @returns {object[]}
   */
  databaseRows() {
    var state = this.dbState
      , rows = [{ section: "数据库 (db/)" }];

    rows.push({
      key: "加密状态",
      value: state.isEncrypted
        ? Theme.chalk.yellow("已加密 (XOR)")
        : Theme.chalk.green("明文")
    });

    rows.push({ key: "文件", value: `${state.encrypted.length} 个已加密 · ${state.plain.length} 个明文` });

    if (state.manifest)
      rows.push({ key: "MANIFEST", value: state.manifest });

    if (!state.isEncrypted) {
      rows.push({ text: Theme.chalk.dim("  明文数据库无需解密，导出时原样复制，导入时也不加密。") });
      return rows
    }

    if (!state.key) {
      rows.push({ text: Theme.chalk.red("  无法推断密钥：缺少 MANIFEST 文件，或 CURRENT 内容不是 MANIFEST 文件名。") });
      rows.push({ text: Theme.chalk.dim("  导出时数据库会保持加密，并记录失败原因。") });
      return rows
    }

    var described = XorEnc.describeKey(state.key);

    rows.push({ key: "推断密钥", value: `${described.ascii}   hex ${described.hex}` });
    rows.push({
      key: "密钥校验",
      value: state.verified === true
        ? Theme.chalk.green("通过（表尾标记匹配）")
        : (state.verified === null ? Theme.chalk.dim("无 .ldb 可用于校验") : Theme.chalk.red("未通过"))
    });
    rows.push({ text: Theme.chalk.dim("  导出时按此密钥解密，密钥写入 manifest；导入时用默认密钥重新加密。") });

    return rows
  }

  /**
   * Rows describing the registry entry.
   * @param {object} record - World record.
   * @returns {object[]}
   */
  recordRows(record) {
    var rows = [{ section: "注册表记录" }];

    for (var [field, label] of RECORD_FIELDS) {
      if (record[field] === undefined)
        continue

      rows.push({ key: label, value: WorldDetailScreen.render(record[field]) });
    }

    if (Array.isArray(record.tag_list) && record.tag_list.length > 0)
      rows.push({ key: "tag_list", value: record.tag_list.join(", ") });

    return rows
  }

  /**
   * Rows describing the level.dat contents.
   * @param {object} meta - Parsed metadata.
   * @returns {object[]}
   */
  metaRows(meta) {
    var rows = [{ section: "level.dat" }]
      , fields = [
          ["levelName", "LevelName"],
          ["levelNameFile", "levelname.txt"],
          ["gameMode", "游戏模式"],
          ["lastPlayed", "最后游玩"],
          ["randomSeed", "随机种子"],
          ["storageVersion", "StorageVersion"],
          ["worldVersion", "WorldVersion"],
          ["networkVersion", "NetworkVersion"],
          ["inventoryVersion", "InventoryVersion"],
          ["lastOpenedWithVersion", "最后客户端版本"],
          ["isHardcore", "极限模式"],
          ["encryptFlag", "neteaseEncryptFlag"],
          ["headerVersion", "头部版本"]
        ];

    for (var [field, label] of fields) {
      var value = meta[field];

      if (value === undefined || value === null)
        continue

      if (field === "lastPlayed")
        value = `${Theme.time(value)} (${value})`;

      rows.push({ key: label, value: String(value) });
    }

    // The two names are deliberately not synchronised, so a mismatch is
    // reported rather than silently reconciled.
    if (meta.levelName && meta.levelNameFile && meta.levelName !== meta.levelNameFile)
      rows.push({ text: Theme.chalk.yellow("  ! level.dat 与 levelname.txt 的名称不一致（两者用途不同，不会自动同步）") });

    return rows
  }

  /**
   * Rows describing the per-user folders.
   * @returns {object[]}
   */
  userRows() {
    var entry = this.entry
      , rows = [{ section: "账号" }]
      , claimed = WorldRecord.userIds(entry.record)
      , present = Object.keys(entry.usersPresent);

    if (claimed.length === 0 && present.length === 0) {
      rows.push({ key: "账号数", value: Theme.chalk.dim("0") });
      rows.push({ text: Theme.chalk.dim("  记录未声明任何账号，本机也没有对应的账号目录。") });
      return rows
    }

    rows.push({
      key: "账号数",
      value: `${claimed.length} 个记录在案 · ${present.length} 个在本机有目录`
    });

    for (var uid of claimed) {
      var stamp = entry.record.user_ids[uid]
        , folder = entry.usersPresent[uid];

      rows.push({
        key: uid,
        value: `${Theme.time(stamp)} · ${folder ? "目录已存在" : Theme.chalk.dim("无目录")}`
      });
    }

    for (var uid of present)
      if (!claimed.includes(uid))
        rows.push({ key: uid, value: Theme.chalk.yellow("目录存在但记录未声明") });

    rows.push({ text: Theme.chalk.dim("  记录中的时间是该账号的登记时间，不是游玩时间。") });

    return rows
  }

  /**
   * Render a record value for display.
   * @param {any} value - Raw value.
   * @returns {string}
   */
  static render(value) {
    if (value === null)
      return "null"
    if (typeof value === "object")
      return JSON.stringify(value)
    return String(value)
  }

  /**
   * Handle screen level hotkeys.
   * @param {string} data - Raw key data.
   * @returns {object|undefined} Consume result.
   */
  handleKey(data) {
    // Escape and Ctrl+C never reach here: the shell routes both to cancel().
    if (matchesKey(data, "b")) {
      this.back();
      return { consume: true }
    }

    if (matchesKey(data, "e")) {
      this.exportWorld();
      return { consume: true }
    }

    if (matchesKey(data, "p")) {
      this.repair();
      return { consume: true }
    }

    // The alt screen leaves its single-line scroll bindings unbound by default,
    // and binding the arrow keys globally would stop them reaching a focused
    // list. The detail view is the only scrollable screen, so it scrolls itself.
    // PageUp and PageDown are already bound, and are left to the alt screen.
    if (this.scroll) {
      if (matchesKey(data, Key.up)) {
        this.scroll.scrollBy(-1);
        return { consume: true }
      }

      if (matchesKey(data, Key.down)) {
        this.scroll.scrollBy(1);
        return { consume: true }
      }

      if (matchesKey(data, Key.home)) {
        this.scroll.scrollToStart();
        return { consume: true }
      }

      if (matchesKey(data, Key.end)) {
        this.scroll.scrollToEnd();
        return { consume: true }
      }
    }

    return undefined
  }

  /**
   * Leave this screen, as Escape and Ctrl+C both ask for.
   * @returns {Promise<void>}
   */
  async cancel() {
    await this.back();
  }

  /**
   * Return to the world list, keeping the cursor on this world.
   * @returns {Promise<void>}
   */
  async back() {
    var WorldListScreen = require("./worldList");

    await this.app.show(new WorldListScreen(this.entry.levelId));
  }

  /**
   * Export this world.
   * @returns {Promise<void>}
   */
  async exportWorld() {
    var ExportWizardScreen = require("./exportWizard");

    await this.app.show(new ExportWizardScreen({
      entries: [this.entry],
      onDone: async () => this.back()
    }));
  }

  /**
   * Register this world folder if it has no record.
   * @returns {Promise<void>}
   */
  async repair() {
    if (this.entry.state !== "unregistered") {
      this.app.setStatus("该世界已经有注册表记录", "warn");
      return
    }

    var WorldImporter = require("../../os/importer")
      , WorldListScreen = require("./worldList")
      , ok = await this.app.confirm("登记世界", [
          `目录：${this.entry.worldDir}`,
          `名称：${Theme.plain(this.entry.displayName)}`,
          "",
          "将在 world_records 中写入一条记录，使客户端能列出该世界。"
        ]);

    if (!ok)
      return

    try {
      await WorldImporter.repair(this.app.layout, this.entry, {});
      await this.app.reloadWorlds();
      await this.app.show(new WorldListScreen());
      this.app.setStatus("已登记", "ok");
    } catch (e) {
      this.app.setStatus(`登记失败：${e.message}`, "error");
    }
  }
}

module.exports = WorldDetailScreen;
