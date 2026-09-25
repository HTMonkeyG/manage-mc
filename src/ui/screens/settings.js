const { SettingsList } = require("@earendil-works/pi-tui");

const Config = require("../../config");
const Theme = require("../theme");

// Labels cycle in SettingsList, so each internal value carries a display form.
const FORMAT_VALUES = ["文件夹", "zip 压缩包"];
const FORMAT_BY_LABEL = { "文件夹": "folder", "zip 压缩包": "zip" };
const FORMAT_LABELS = { folder: "文件夹", zip: "zip 压缩包" };

const COLLISION_VALUES = ["导入为副本", "替换现有", "合并账号目录"];
const COLLISION_BY_LABEL = { "导入为副本": "copy", "替换现有": "replace", "合并账号目录": "merge" };
const COLLISION_LABELS = { copy: "导入为副本", replace: "替换现有", merge: "合并账号目录" };

const USERS_MODE_VALUES = ["复制内容", "仅建目录"];
const USERS_MODE_BY_LABEL = { "复制内容": "copy", "仅建目录": "empty" };
const USERS_MODE_LABELS = { copy: "复制内容", empty: "仅建目录" };

const YES_NO_VALUES = ["否", "是"];

class SettingsScreen {
  /**
   * Settings screen, backed by the persisted configuration file.
   */
  constructor() {
    this.app = null;
    this.list = null;
    this.status = "";
  }

  /**
   * Screen title.
   * @returns {string}
   */
  title() {
    return "设置"
  }

  /**
   * Screen subtitle.
   * @returns {string}
   */
  subtitle() {
    return this.app && this.app.layout ? this.app.layout.root : "未设置"
  }

  /**
   * Key hint.
   * @returns {string}
   */
  hint() {
    return "↑↓ 选择 · Enter/空格 切换 · r 更换数据目录 · Esc/b 返回 · q 退出"
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

    var config = app.config;

    this.list = new SettingsList(
      this.buildItems(config),
      SettingsScreen.visibleRows(),
      Theme.settingsList(),
      (id, label) => this.apply(id, label),
      () => this.back()
    );

    return this.list
  }

  /**
   * Estimate how many rows the viewport can show.
   * @returns {number}
   */
  static visibleRows() {
    var rows = process.stdout.rows || 24;
    return Math.max(4, rows - 5)
  }

  /**
   * Build the settings rows from the current configuration.
   * @param {object} config - Effective configuration.
   * @returns {object[]}
   */
  buildItems(config) {
    return [
      {
        id: "gameRoot",
        label: "游戏数据目录",
        description: "按 r 键更换。当前：" + (config.gameRoot || "（未设置）"),
        // SettingsList renders currentValue for every row, so an informational
        // row still needs one; without a values list it is not cyclable.
        currentValue: config.gameRoot ? "已设置" : "未设置"
      },
      {
        id: "exportFormat",
        label: "导出格式",
        description: "zip 需要安装 adm-zip；超大世界建议使用文件夹",
        currentValue: FORMAT_LABELS[config.export.format] || "文件夹",
        values: FORMAT_VALUES
      },
      {
        id: "includeOrphanUsers",
        label: "收集孤立账号目录",
        description: "同时收集记录未声明、但目录名匹配的账号文件夹",
        currentValue: config.export.includeOrphanUsers ? "是" : "否",
        values: YES_NO_VALUES
      },
      {
        id: "usersMode",
        label: "账号目录写入方式",
        description: "导入时复制来源内容，或只创建空目录",
        currentValue: USERS_MODE_LABELS[config.import.usersMode || "copy"] || "复制内容",
        values: USERS_MODE_VALUES
      },
      {
        id: "onCollision",
        label: "同名世界冲突处理",
        description: "导入时目标已存在同名世界或记录的处理方式",
        currentValue: COLLISION_LABELS[config.import.onCollision] || "导入为副本",
        values: COLLISION_VALUES
      },
      {
        id: "configPath",
        label: "配置文件",
        description: Config.filePath(),
        currentValue: "—"
      }
    ]
  }

  /**
   * Persist a changed setting.
   * @param {string} id - Setting id.
   * @param {string} label - New display value.
   * @returns {Promise<void>}
   */
  async apply(id, label) {
    var patch = null;

    if (id === "exportFormat")
      patch = { export: { format: FORMAT_BY_LABEL[label] || "folder" } };
    else if (id === "includeOrphanUsers")
      patch = { export: { includeOrphanUsers: label === "是" } };
    else if (id === "usersMode")
      patch = { import: { usersMode: USERS_MODE_BY_LABEL[label] || "copy" } };
    else if (id === "onCollision")
      patch = { import: { onCollision: COLLISION_BY_LABEL[label] || "copy" } };

    if (!patch)
      return

    try {
      this.app.config = await Config.save(patch);
      this.app.setStatus("设置已保存", "ok");
    } catch (e) {
      this.app.setStatus(`保存失败：${e.message}`, "error");
    }
  }

  /**
   * Handle screen level hotkeys.
   * @param {string} data - Raw key data.
   * @returns {object|undefined} Consume result.
   */
  handleKey(data) {
    if (data === "q") {
      this.app.quit();
      return { consume: true }
    }

    if (data === "r") {
      this.changeRoot();
      return { consume: true }
    }

    if (data === "b" || data === "\u001b") {
      this.back();
      return { consume: true }
    }

    return undefined
  }

  /**
   * Return to the world list.
   * @returns {Promise<void>}
   */
  async back() {
    var WorldListScreen = require("./worldList");

    await this.app.show(new WorldListScreen());
  }

  /**
   * Pick a different game data root.
   * @returns {Promise<void>}
   */
  async changeRoot() {
    var RootSetupScreen = require("./rootSetup");

    await this.app.show(new RootSetupScreen());
  }
}

module.exports = SettingsScreen;
