const { SelectList, matchesKey } = require("@earendil-works/pi-tui");

const WorldRegistry = require("../../records/registry");
const Theme = require("../theme");

// Only these states carry world data on this machine.
const EXPORTABLE = ["registered", "unregistered", "online"];

const HINT = "Enter 详情 · i 导入 · e 导出 · E 导出全部 · p 注册 · r 刷新 · s 设置 · q 退出";

class WorldListScreen {
  /**
   * Main screen: every world the registry and the folder set describe.
   */
  constructor() {
    this.app = null;
    this.list = null;
    this.items = [];
    this.registry = [];
    this.measuring = false;
  }

  /**
   * Screen title.
   * @returns {string}
   */
  title() {
    return "世界列表"
  }

  /**
   * Screen subtitle.
   * @returns {string}
   */
  subtitle() {
    return this.app && this.app.layout ? this.app.layout.root : ""
  }

  /**
   * Key hint shown when no message is pending.
   * @returns {string}
   */
  hint() {
    return HINT
  }

  /**
   * Component that should hold keyboard focus.
   * @returns {object}
   */
  focus() {
    return this.list
  }

  /**
   * Build the screen.
   * @param {object} app - Application shell.
   * @returns {Promise<object>} Component to mount.
   */
  async mount(app) {
    this.app = app;
    this.rebuild();

    // Sizes arrive after the first paint, so a slow disk never delays the list.
    this.measureAll();

    return this.list
  }

  /**
   * Rebuild the list from the current registry view.
   * @returns {void}
   */
  rebuild() {
    this.registry = this.app.entries || [];

    this.items = this.registry.map(entry => ({
      value: entry.levelId,
      label: WorldListScreen.labelOf(entry),
      description: WorldListScreen.describeOf(entry)
    }));

    if (!this.list) {
      this.list = new SelectList(this.items, WorldListScreen.visibleRows(), Theme.selectList());
      this.list.onSelect = item => this.openDetail(item.value);
      this.list.onCancel = () => this.app.quit();
    }
  }

  /**
   * Estimate how many rows the viewport can show.
   *
   * The list owns its own scrolling window, so it must not be nested inside a
   * ScrollView; it is given the viewport height directly instead.
   * @returns {number}
   */
  static visibleRows() {
    var rows = process.stdout.rows || 24;
    return Math.max(5, rows - 5)
  }

  /**
   * Build the primary column for an entry.
   * @param {object} entry - World entry.
   * @returns {string}
   */
  static labelOf(entry) {
    var name = Theme.plain(entry.displayName) || entry.levelId
      , marker = entry.anomalies.length > 0 ? " ⚠" : "";

    return `${name}  [${Theme.stateLabel(entry.state)}]${marker}`
  }

  /**
   * Build the secondary column for an entry.
   *
   * State is written as text rather than colour because SelectList styles the
   * whole selected row, which would override a nested colour.
   * @param {object} entry - World entry.
   * @returns {string}
   */
  static describeOf(entry) {
    var parts = []

    if (entry.size)
      parts.push(`${Theme.size(entry.size.bytes)}`)

    var accounts = Object.keys(entry.usersPresent).length;

    if (entry.userIds.length > 0)
      parts.push(`${entry.userIds.length} 账号`)
    else if (accounts > 0)
      parts.push(`${accounts} 账号目录`)

    if (entry.state === "online")
      parts.push("仅注册表")
    else if (entry.state === "dangling")
      parts.push("无世界数据")
    else if (entry.state === "unregistered")
      parts.push("未登记")

    parts.push(entry.levelId);

    return parts.join(" · ")
  }

  /**
   * Measure world folder sizes one at a time, refreshing as they land.
   * @returns {Promise<void>}
   */
  async measureAll() {
    if (this.measuring)
      return

    this.measuring = true;

    try {
      for (var index = 0; index < this.registry.length; index++) {
        var entry = this.registry[index];

        if (!entry.worldDir || entry.size)
          continue

        try {
          await WorldRegistry.measure(entry);
        } catch (e) {
          continue
        }

        this.refreshItem(index);
      }
    } finally {
      this.measuring = false;
    }
  }

  /**
   * Update one row in place.
   * @param {number} index - Row index.
   * @returns {void}
   */
  refreshItem(index) {
    var entry = this.registry[index]
      , item = this.items[index];

    if (!entry || !item)
      return

    item.label = WorldListScreen.labelOf(entry);
    item.description = WorldListScreen.describeOf(entry);

    this.app.tui.requestRender();
  }

  /**
   * Reload everything from disk.
   * @returns {Promise<void>}
   */
  async refresh() {
    this.app.setStatus("正在重新读取…", "busy");

    try {
      await this.app.reloadWorlds();
    } catch (e) {
      this.app.setStatus(`读取失败：${e.message}`, "error");
      return
    }

    this.list = null;
    this.app.body.clear();
    this.rebuild();
    this.app.body.addChild(this.list);
    this.app.tui.setFocus(this.list);

    var counts = WorldRegistry.countByState(this.registry);

    this.app.setStatus(`共 ${this.registry.length} 个条目：正常 ${counts.registered} · 未注册 ${counts.unregistered} · 在线 ${counts.online} · 数据缺失 ${counts.dangling}`, "ok");

    this.measureAll();
  }

  /**
   * Currently highlighted entry.
   * @returns {object|null}
   */
  selected() {
    var item = this.list ? this.list.getSelectedItem() : null;

    if (!item)
      return null

    return this.registry.find(entry => entry.levelId === item.value) || null
  }

  /**
   * Open the detail screen for a world.
   * @param {string} levelId - Level id to open.
   * @returns {Promise<void>}
   */
  async openDetail(levelId) {
    var entry = this.registry.find(item => item.levelId === levelId);

    if (!entry)
      return

    var WorldDetailScreen = require("./worldDetail");
    await this.app.show(new WorldDetailScreen(entry));
  }

  /**
   * Handle screen level hotkeys.
   * @param {string} data - Raw key data.
   * @returns {object|undefined} Consume result.
   */
  handleKey(data) {
    if (matchesKey(data, "q")) {
      this.app.quit();
      return { consume: true }
    }

    if (matchesKey(data, "i")) {
      this.startImport();
      return { consume: true }
    }

    if (matchesKey(data, "e")) {
      this.startExport();
      return { consume: true }
    }

    if (matchesKey(data, "shift+e")) {
      this.startExportAll();
      return { consume: true }
    }

    if (matchesKey(data, "p")) {
      this.repair();
      return { consume: true }
    }

    if (matchesKey(data, "r")) {
      this.refresh();
      return { consume: true }
    }

    if (matchesKey(data, "s")) {
      this.settings();
      return { consume: true }
    }

    return undefined
  }

  /**
   * Open the import wizard.
   * @returns {Promise<void>}
   */
  async startImport() {
    var ImportWizardScreen = require("./importWizard");

    await this.app.show(new ImportWizardScreen({
      onDone: async () => {
        await this.app.reloadWorlds();
        await this.app.show(new WorldListScreen());
      }
    }));
  }

  /**
   * Export the highlighted world.
   * @returns {Promise<void>}
   */
  async startExport() {
    var entry = this.selected();

    if (!entry) {
      this.app.setStatus("没有选中任何世界", "warn");
      return
    }

    await this.openExport([entry]);
  }

  /**
   * Export every entry that has local data.
   * @returns {Promise<void>}
   */
  async startExportAll() {
    var candidates = this.registry.filter(entry => entry.worldDir !== null);

    if (candidates.length === 0) {
      this.app.setStatus("当前没有可导出的世界数据", "warn");
      return
    }

    await this.openExport(candidates);
  }

  /**
   * Open the export wizard for a set of entries.
   * @param {object[]} entries - Worlds to export.
   * @returns {Promise<void>}
   */
  async openExport(entries) {
    var ExportWizardScreen = require("./exportWizard");

    await this.app.show(new ExportWizardScreen({
      entries: entries,
      onDone: async () => {
        await this.app.show(new WorldListScreen());
      }
    }));
  }

  /**
   * Register a world folder that has no record.
   * @returns {Promise<void>}
   */
  async repair() {
    var entry = this.selected();

    if (!entry || entry.state !== "unregistered") {
      this.app.setStatus("请选择一个「未注册」的世界（标记为未注册的目录可被登记）", "warn");
      return
    }

    var WorldImporter = require("../../os/importer")
      , ok = await this.app.confirm("登记世界", [
          `目录：${entry.worldDir}`,
          `名称：${Theme.plain(entry.displayName)}`,
          "",
          "将在 world_records 中写入一条记录，使客户端能列出该世界。"
        ]);

    if (!ok)
      return

    try {
      await this.app.withProgress("正在登记…", async () => {
        return WorldImporter.repair(this.app.layout, entry, {});
      });

      await this.app.reloadWorlds();
      await this.app.show(new WorldListScreen());
    } catch (e) {
      this.app.setStatus(`登记失败：${e.message}`, "error");
    }
  }

  /**
   * Open the settings screen.
   * @returns {Promise<void>}
   */
  async settings() {
    var SettingsScreen = require("./settings");

    await this.app.show(new SettingsScreen());
  }
}

module.exports = WorldListScreen;
