const { ScrollView, Key, matchesKey } = require("@earendil-works/pi-tui");

const LevelId = require("../../records/levelid");
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
    var base = "↑↓ 滚动 · e 导出 · b/Esc 返回 · q 退出";

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
      rows.push({ text: Theme.chalk.dim("  （无）") });
      return rows
    }

    for (var uid of claimed) {
      var lastPlayed = entry.record.user_ids[uid]
        , folder = entry.usersPresent[uid];

      rows.push({
        key: uid,
        value: `${Theme.time(lastPlayed)} · ${folder ? "目录已存在" : Theme.chalk.dim("无目录")}`
      });
    }

    for (var uid of present)
      if (!claimed.includes(uid))
        rows.push({ key: uid, value: Theme.chalk.yellow("目录存在但记录未声明") });

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
    if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("q"))) {
      this.app.quit();
      return { consume: true }
    }

    // Escape is matched rather than compared against a literal: the same key
    // arrives as a bare \x1b or as the Kitty sequence \x1b[27u depending on the
    // terminal, and only one of those equals "\u001b".
    if (matchesKey(data, Key.escape) || matchesKey(data, "b")) {
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
