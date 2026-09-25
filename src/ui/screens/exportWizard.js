const fs = require("fs")
  , path = require("path");

const { Container, Input, Spacer, Text, Key, matchesKey } = require("@earendil-works/pi-tui");

const Config = require("../../config");
const Fsx = require("../../os/fsx");
const Pack = require("../../os/pack");
const WorldExporter = require("../../os/exporter");
const Theme = require("../theme");
const InfoPanel = require("../components/infoPanel");
const RootSetupScreen = require("./rootSetup");

// Longest list still shown entry by entry in a confirmation.
const LIST_LIMIT = 10;

class ExportWizardScreen {
  /**
   * Export wizard: pick a destination, then write a folder or a zip.
   * @param {object} opts - Options.
   * @param {object[]} opts.entries - Worlds to export.
   * @param {function(): Promise<void>} [opts.onDone] - Called when the wizard closes.
   */
  constructor(opts) {
    var options = opts || {};

    this.entries = options.entries || [];
    this.onDone = options.onDone;
    this.app = null;
    this.busy = false;
    this.container = new Container();
    this.input = new Input({
      prompt: "目标 > ",
      placeholder: "E:/path/to/output"
    });
    this.info = new InfoPanel();
  }

  /**
   * Screen title.
   * @returns {string}
   */
  title() {
    return "导出存档"
  }

  /**
   * Screen subtitle.
   * @returns {string}
   */
  subtitle() {
    return `${this.entries.length} 个世界`
  }

  /**
   * Key hint.
   * @returns {string}
   */
  hint() {
    return "输入目标目录后按 Enter · Esc 返回"
  }

  /**
   * Component that should hold keyboard focus.
   * @returns {object}
   */
  focus() {
    return this.input
  }

  /**
   * Build the screen.
   * @param {object} app - Application shell.
   * @returns {Promise<object>} Component to mount.
   */
  async mount(app) {
    this.app = app;

    var format = app.config.export.format
      , zipReady = Pack.available();

    this.input.setValue(app.config.lastExportDir || "");
    this.input.onSubmit = value => this.start(value);

    this.container.addChild(new Text("选择导出目标目录，包会写在该目录下。", 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.input);
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.info);

    var rows = [{ section: "将导出" }];

    for (var entry of this.entries.slice(0, LIST_LIMIT))
      rows.push({
        text: `  · ${Theme.plain(entry.displayName)} [${Theme.stateLabel(entry.state)}] ${entry.worldDir ? "" : Theme.chalk.dim("（无世界数据，仅注册表）")}`
      });

    if (this.entries.length > LIST_LIMIT)
      rows.push({ text: `  … 其余 ${this.entries.length - LIST_LIMIT} 个` });

    rows.push({ section: "格式" });
    rows.push({ text: `  当前：${format === "zip" ? "zip 压缩包" : "文件夹"}（可在设置中修改）` });

    if (format === "zip" && !zipReady)
      rows.push({ text: Theme.chalk.red("  ! 未安装 adm-zip，zip 不可用。请运行：npm install adm-zip") });

    rows.push({ section: "说明" });
    rows.push({ text: Theme.chalk.dim("  包内为 minecraftWorlds、storage/stream 与 manifest.json。") });
    rows.push({ text: Theme.chalk.dim("  账号目录只收集目录名与该世界 id 相同的部分。") });

    this.info.setRows(rows);

    return this.container
  }

  /**
   * Handle screen level hotkeys.
   * @param {string} data - Raw key data.
   * @returns {object|undefined} Consume result.
   */
  handleKey(data) {
    // Matched, not compared: Escape arrives as \x1b or \x1b[27u depending on
    // the terminal, and every other key belongs to the focused path input.
    if (matchesKey(data, Key.escape)) {
      this.back();
      return { consume: true }
    }

    return undefined
  }

  /**
   * Return to the previous screen.
   * @returns {Promise<void>}
   */
  async back() {
    if (this.onDone)
      await this.onDone()
  }

  /**
   * Validate the destination and run the export.
   * @param {string} raw - Raw path from the input.
   * @returns {Promise<void>}
   */
  async start(raw) {
    if (this.busy)
      return

    var value = String(raw || "").trim();

    if (!value) {
      this.app.setStatus("请输入导出目标目录", "warn");
      return
    }

    if (this.entries.length === 0) {
      this.app.setStatus("没有可导出的世界", "warn");
      return
    }

    var dest = RootSetupScreen.expand(value)
      , format = this.app.config.export.format === "zip" ? "zip" : "folder";

    if (format === "zip" && !Pack.available()) {
      this.app.setStatus("未安装 adm-zip，无法导出为 zip。请运行 npm install adm-zip", "error");
      return
    }

    if (!(await Fsx.existsDir(dest))) {
      var create = await this.app.confirm("目标目录不存在", [
        `目标：${dest}`,
        "是否创建该目录？"
      ], "Enter 创建 · Esc 取消");

      if (!create)
        return

      try {
        fs.mkdirSync(dest, { recursive: true });
      } catch (e) {
        this.app.setStatus(`无法创建目录：${e.message}`, "error");
        return
      }
    }

    var name = WorldExporter.packageName(this.app.layout, this.entries, null)
      , target = path.join(dest, format === "zip" ? `${name}.zip` : name);

    if (await Fsx.exists(target)) {
      this.app.setStatus(`目标已存在：${target}`, "error");
      await this.app.alert("导出中止", [`目标已存在，未覆盖：`, target]);
      return
    }

    var lines = [`目标：${target}`, `格式：${format === "zip" ? "zip 压缩包" : "文件夹"}`],
      totalBytes = 0;

    for (var entry of this.entries.slice(0, LIST_LIMIT)) {
      lines.push(`· ${Theme.plain(entry.displayName)} → ${entry.levelId}`);
      totalBytes += entry.size ? entry.size.bytes : 0;
    }

    if (this.entries.length > LIST_LIMIT)
      lines.push(`… 其余 ${this.entries.length - LIST_LIMIT} 个`);

    var proceed = await this.app.confirm("开始导出", lines, "Enter 开始 · Esc 取消");

    if (!proceed)
      return

    await this.run(dest, format);
  }

  /**
   * Run the export and report the outcome.
   * @param {string} dest - Destination directory.
   * @param {string} format - "folder" or "zip".
   * @returns {Promise<void>}
   */
  async run(dest, format) {
    var report;

    this.busy = true;

    try {
      report = await this.app.withProgress("正在导出…", progress => WorldExporter.exportWorlds(
        this.app.layout,
        this.entries,
        dest,
        {
          format: format,
          includeUsers: this.app.config.export.includeUsers !== false,
          includeOrphanUsers: Boolean(this.app.config.export.includeOrphanUsers),
          onProgress: progress
        }
      ));
    } catch (e) {
      if (e.aborted) {
        this.app.setStatus("已取消导出", "warn");
        return
      }

      this.app.setStatus(`导出失败：${e.message}`, "error");
      await this.app.alert("导出失败", [e.message]);
      return
    } finally {
      this.busy = false;
    }

    await Config.save({ lastExportDir: dest });

    var lines = [
      `目标：${report.target}`,
      `世界：${report.worlds} 个 · ${Theme.size(report.bytes)} · ${report.files} 个文件`
    ];

    for (var warning of report.warnings)
      lines.push(`! ${warning}`);

    this.app.setStatus(`导出完成：${report.worlds} 个世界`, "ok");
    await this.app.alert("导出完成", lines);

    if (this.onDone)
      await this.onDone()
  }
}

module.exports = ExportWizardScreen;
