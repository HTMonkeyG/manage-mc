const { SelectList, matchesKey } = require("@earendil-works/pi-tui");

const WorldRemoval = require("../../records/removal");
const AccountPicker = require("../components/accountPicker");
const Theme = require("../theme");

// The operations offered here. Every one of them changes or destroys data that
// takes work to recreate, so each is confirmed with a generated code.
const ACTIONS = [
  {
    id: "replace",
    label: "替换存档",
    description: "从文件夹、zip 或导出包替换该存档，保留现有 level_id 与账号"
  },
  {
    id: "unregister",
    label: "删除账号记录",
    description: "只从注册表中移除所选账号，世界目录与数据库原样保留"
  },
  {
    id: "delete",
    label: "删除存档",
    description: "删除世界目录、数据库、注册表记录与账号目录"
  }
];

class DangerZoneScreen {
  /**
   * Dangerous operations for one world.
   *
   * Kept apart from the detail screen so nothing destructive sits next to the
   * everyday keys, and every action here is confirmed by typing a code.
   * @param {object} entry - World entry to operate on.
   * @param {object} [opts] - Options.
   * @param {function(): Promise<void>} [opts.onLeave] - Called when leaving back to the detail screen.
   */
  constructor(entry, opts) {
    this.entry = entry;
    this.onLeave = (opts || {}).onLeave;
    this.app = null;
    this.list = null;
    this.items = [];
    this.busy = false;
  }

  /**
   * Screen title.
   * @returns {string}
   */
  title() {
    return "危险区"
  }

  /**
   * Screen subtitle.
   * @returns {string}
   */
  subtitle() {
    return `${Theme.plain(this.entry.displayName)} · ${this.entry.levelId}`
  }

  /**
   * Key hint.
   * @returns {string}
   */
  hint() {
    return "↑↓ 选择 · Enter 执行 · Esc/Ctrl+C 返回 · 每项操作都需输入验证码"
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

    this.items = ACTIONS.map(action => ({
      value: action.id,
      label: Theme.chalk.red(action.label),
      description: action.description
    }));

    this.list = new SelectList(this.items, DangerZoneScreen.visibleRows(), Theme.selectList());
    this.list.onSelect = item => this.run(item.value);

    return this.list
  }

  /**
   * Estimate how many rows the viewport can show.
   * @returns {number}
   */
  static visibleRows() {
    var rows = process.stdout.rows || 24;
    return Math.max(4, rows - 6)
  }

  /**
   * Handle screen level hotkeys.
   * @param {string} data - Raw key data.
   * @returns {object|undefined} Consume result.
   */
  handleKey(data) {
    if (matchesKey(data, "b")) {
      this.leave();
      return { consume: true }
    }

    return undefined
  }

  /**
   * Leave the screen, as Escape and Ctrl+C both ask for.
   * @returns {Promise<void>}
   */
  async cancel() {
    if (this.busy)
      return

    await this.leave()
  }

  /**
   * Return to the detail screen.
   * @returns {Promise<void>}
   */
  async leave() {
    if (this.onLeave)
      await this.onLeave()
  }

  /**
   * Run the highlighted action.
   * @param {string} id - Action id.
   * @returns {Promise<void>}
   */
  async run(id) {
    if (this.busy)
      return

    if (id === "replace")
      return this.replace();

    if (id === "unregister")
      return this.unregister();

    if (id === "delete")
      return this.deleteWorld();
  }

  /**
   * Replace this world with another source.
   *
   * Handed to the import wizard, which already knows how to read a source and
   * what "replace" means; the only difference is that the destination id is
   * fixed to this world rather than decided by the source.
   * @returns {Promise<void>}
   */
  async replace() {
    var ok = await this.app.confirmDanger("替换存档", [
      `将被替换：${Theme.plain(this.entry.displayName)}`,
      `level_id：${this.entry.levelId}`,
      "",
      "替换后该存档的内容与注册表记录都会变成来源的样子，",
      "世界目录、数据库与记录会被整体覆盖。",
      this.entry.worldDir ? "" : Theme.chalk.yellow("该条目没有世界目录，替换将直接新建。")
    ].filter(l => l !== undefined));

    if (!ok)
      return

    var ImportWizardScreen = require("./importWizard")
      , WorldListScreen = require("./worldList");

    this.busy = true;

    await this.app.show(new ImportWizardScreen({
      target: this.entry,
      onDone: async () => {
        await this.app.reloadWorlds();
        await this.app.show(new WorldListScreen(this.entry.levelId));
      }
    }));
  }

  /**
   * Drop accounts from this world's record.
   * @returns {Promise<void>}
   */
  async unregister() {
    var claimed = this.entry.userIds.slice();

    if (claimed.length === 0) {
      this.app.setStatus("该存档的注册表记录中没有账号", "warn");
      return
    }

    var picked = await this.pickAccounts("选择要删除记录的账号", claimed);

    if (picked === null || picked.length === 0) {
      this.app.setStatus("没有选择任何账号", "warn");
      return
    }

    var remaining = claimed.filter(uid => !picked.includes(uid));

    var ok = await this.app.confirmDanger("删除账号记录", [
      `存档：${Theme.plain(this.entry.displayName)}`,
      `将移除：${picked.join("、")}`,
      "",
      "仅从注册表记录的 user_ids 中移除这些账号。",
      "世界目录、数据库与账号目录都不会被改动。",
      remaining.length === 0
        ? Theme.chalk.yellow("移除后该记录不再关联任何账号，客户端可能不再列出它。")
        : `剩余账号：${remaining.join("、")}`
    ]);

    if (!ok)
      return

    this.busy = true;

    try {
      var report = await WorldRemoval.removeAccounts(this.app.layout, this.entry, picked);

      await this.app.reloadWorlds();

      var WorldDetailScreen = require("./worldDetail")
        , refreshed = this.app.entries.find(e => e.levelId === this.entry.levelId);

      this.app.setStatus(`已移除 ${report.removed.length} 个账号记录`, "ok");

      if (refreshed)
        await this.app.show(new WorldDetailScreen(refreshed));
      else
        await this.app.show(new (require("./worldList"))());
    } catch (e) {
      this.app.setStatus(`删除账号记录失败：${e.message}`, "error");
      await this.app.alert("删除账号记录失败", [e.message]);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Delete the world entirely.
   * @returns {Promise<void>}
   */
  async deleteWorld() {
    var uids = await WorldRemoval.collectAccountUids(this.app.layout, this.entry.levelId)
      , lines = [
          `存档：${Theme.plain(this.entry.displayName)}`,
          `level_id：${this.entry.levelId}`,
          ""
        ];

    lines.push(this.entry.worldDir
      ? `将删除世界目录与数据库：${this.entry.worldDir}`
      : Theme.chalk.yellow("该条目没有世界目录，只会删除注册表记录。"));

    if (this.entry.recordFile)
      lines.push(`将删除注册表记录：${this.entry.recordFile}`);

    lines.push(uids.length > 0
      ? `将删除 ${uids.length} 个账号目录：${uids.join("、")}`
      : "没有账号目录需要删除。");

    lines.push("");
    lines.push(Theme.chalk.yellow("此操作不可撤销。"));

    var ok = await this.app.confirmDanger("删除存档", lines);

    if (!ok)
      return

    this.busy = true;

    try {
      var report = await WorldRemoval.deleteWorld(this.app.layout, this.entry);

      await this.app.reloadWorlds();
      await this.app.show(new (require("./worldList"))());

      this.app.setStatus(`已删除存档：${WorldRemoval.summarize(report)}`, "ok");

      if (report.warnings.length > 0)
        await this.app.alert("删除完成，但有需要处理的项", report.warnings);
    } catch (e) {
      this.app.setStatus(`删除失败：${e.message}`, "error");
      await this.app.alert("删除失败", [e.message, "", "未能删除的内容已尽量还原。"]);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Ask which accounts to act on.
   * @param {string} title - Picker heading.
   * @param {string[]} candidates - Account ids to offer.
   * @returns {Promise<string[]|null>} Chosen ids, or null when cancelled.
   */
  pickAccounts(title, candidates) {
    return new Promise(resolve => {
      var picker = new AccountPicker({
        app: this.app,
        title: title,
        allowAdd: false,
        // Marked so the picker does not fall back to its import wording.
        candidates: candidates.map(uid => ({ uid: uid, note: "记录在案的账号" })),
        done: chosen => {
          handle.hide();
          this.app.tui.requestRender();
          resolve(chosen);
        }
      });

      var handle = this.app.showModal(picker, {
        width: "70%",
        minWidth: 44,
        maxHeight: "70%",
        anchor: "center"
      });
    })
  }
}

module.exports = DangerZoneScreen;
