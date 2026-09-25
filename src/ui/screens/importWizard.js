const { Container, Input, Spacer, Text } = require("@earendil-works/pi-tui");

const Config = require("../../config");
const Fsx = require("../../os/fsx");
const SourceDetector = require("../../os/detect");
const WorldImporter = require("../../os/importer");
const Theme = require("../theme");
const InfoPanel = require("../components/infoPanel");
const RootSetupScreen = require("./rootSetup");

// Source kinds reported by the detector, in user facing terms.
const KIND_LABELS = {
  "managed-export": "本程序导出的包",
  "game-root": "完整游戏数据目录",
  "worlds-dir": "minecraftWorlds 目录",
  "bare-world": "单个世界目录",
  "records-root": "仅注册表（无世界数据）",
  "multi-world": "包含多个世界的目录"
};

// Longest list still shown entry by entry in a confirmation.
const LIST_LIMIT = 8;

class ImportWizardScreen {
  /**
   * Import wizard: pick a source, review the plan, then copy it in.
   * @param {object} opts - Options.
   * @param {function(): Promise<void>} [opts.onDone] - Called after a successful import.
   */
  constructor(opts) {
    this.onDone = (opts || {}).onDone;
    this.app = null;
    this.busy = false;
    this.container = new Container();
    this.input = new Input({
      prompt: "来源 > ",
      placeholder: "存档目录 / zip / 导出包 / 游戏数据目录"
    });
    this.info = new InfoPanel();
  }

  /**
   * Screen title.
   * @returns {string}
   */
  title() {
    return "导入存档"
  }

  /**
   * Screen subtitle.
   * @returns {string}
   */
  subtitle() {
    return this.app && this.app.layout ? `目标：${this.app.layout.root}` : ""
  }

  /**
   * Key hint.
   * @returns {string}
   */
  hint() {
    return "输入来源路径后按 Enter 识别 · Esc 返回"
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
    this.input.setValue(app.config.lastImportPath || "");
    this.input.onSubmit = value => this.start(value);

    this.container.addChild(new Text("选择要导入的存档来源。", 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.input);
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.info);

    this.info.setRows([
      { section: "支持的来源" },
      { text: "  本程序导出的包（含 manifest.json）" },
      { text: "  单个世界目录（含 level.dat）" },
      { text: "  minecraftWorlds 目录，或完整游戏数据目录" },
      { text: "  仅含注册表的 storage/storge 目录" },
      { text: "  zip 压缩包（需安装 adm-zip）" },
      { section: "说明" },
      { text: Theme.chalk.dim("  记录中的 path 会按目标机器重新计算，不会沿用来源机器的路径。") },
      { text: Theme.chalk.dim("  同名世界默认以副本方式导入，会分配新的 level_id。") }
    ]);

    return this.container
  }

  /**
   * Handle screen level hotkeys.
   * @param {string} data - Raw key data.
   * @returns {object|undefined} Consume result.
   */
  handleKey(data) {
    if (data === "\u001b") {
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
   * Describe a source kind for the user.
   * @param {string} kind - Detector kind.
   * @returns {string}
   */
  static kindLabel(kind) {
    var plain = String(kind || "").replace(/^zip:/, "")
      , label = KIND_LABELS[plain] || plain;

    return String(kind).startsWith("zip:") ? `${label}（来自 zip）` : label
  }

  /**
   * Detect the source and walk the user through the import.
   * @param {string} raw - Raw path from the input.
   * @returns {Promise<void>}
   */
  async start(raw) {
    if (this.busy)
      return

    var value = String(raw || "").trim();

    if (!value) {
      this.app.setStatus("请输入来源路径", "warn");
      return
    }

    if (!this.app.layout) {
      this.app.setStatus("尚未设置游戏数据目录", "error");
      return
    }

    var resolved = RootSetupScreen.expand(value);

    this.busy = true;

    try {
      this.app.setStatus("正在识别来源…", "busy");

      var source = await SourceDetector.detect(resolved);
      this.app.setStatus("");

      await this.review(source, resolved);
    } catch (e) {
      this.app.setStatus(`识别失败：${e.message}`, "error");
    } finally {
      this.busy = false;
    }
  }

  /**
   * Show what was detected and confirm before writing anything.
   * @param {object} source - Detected source.
   * @param {string} resolved - Absolute source path.
   * @returns {Promise<void>}
   */
  async review(source, resolved) {
    var lines = [
      `来源类型：${ImportWizardScreen.kindLabel(source.kind)}`,
      `来源路径：${source.rootPath}`,
      `识别到 ${source.worlds.length} 个世界`
    ];

    if (source.worlds.length <= LIST_LIMIT)
      for (var world of source.worlds)
        lines.push(`  · ${world.levelId}${world.worldDir ? "" : "（无世界数据）"}`);

    for (var warning of source.warnings)
      lines.push(`! ${warning}`);

    var proceed = await this.app.confirm("确认导入来源", lines, "Enter 继续 · Esc 取消");

    if (!proceed)
      return

    var plan, preflight;

    try {
      plan = await WorldImporter.plan(this.app.layout, source, {
        onCollision: this.app.config.import.onCollision
      });
      preflight = await WorldImporter.preflight(plan, this.app.layout);
    } catch (e) {
      this.app.setStatus(`无法规划导入：${e.message}`, "error");
      return
    }

    if (!preflight.ok) {
      await this.app.alert("无法导入", preflight.problems.map(problem => `! ${problem.message}`));
      this.app.setStatus("导入被预检拒绝，未写入任何内容", "error");
      return
    }

    var planLines = [];

    for (var step of plan.steps)
      planLines.push(`· ${Theme.plain(step.record.name)} → ${step.destId}${step.minted ? "（新 id）" : ""} · ${Theme.size(step.size.bytes)}`);

    for (var note of plan.warnings.concat(preflight.warnings))
      planLines.push(`! ${note}`);

    planLines.push(`合计 ${Theme.size(plan.bytes)} / ${plan.files} 个文件`);

    proceed = await this.app.confirm("即将写入", planLines, "Enter 开始导入 · Esc 取消");

    if (!proceed)
      return

    await this.run(plan, source, resolved);
  }

  /**
   * Execute the import and report the outcome.
   * @param {object} plan - Import plan.
   * @param {object} source - Detected source.
   * @param {string} resolved - Absolute source path.
   * @returns {Promise<void>}
   */
  async run(plan, source, resolved) {
    var report;

    try {
      report = await this.app.withProgress("正在导入…", progress => WorldImporter.execute(plan, {
        onProgress: progress
      }));
    } catch (e) {
      if (e.aborted) {
        this.app.setStatus("已取消导入", "warn");
        return
      }

      this.app.setStatus(`导入失败：${e.message}`, "error");
      await this.app.alert("导入失败", [e.message, "", "已尽可能回滚；未登记的世界目录会在列表中显示为「未注册」，可用 p 键登记。"]);
      return
    }

    await this.app.reloadWorlds();

    var lines = report.results.map(result => {
      var parts = [`· ${Theme.plain(result.record.name)} → ${result.levelId}`];

      if (result.minted)
        parts.push(`（新 id，原 ${result.originalLevelId}）`);

      if (result.users.length > 0)
        parts.push(`· 账号 ${result.users.join(", ")}`);

      if (result.synthesized)
        parts.push("· 记录为生成");

      return parts.join(" ")
    });

    for (var warning of report.warnings)
      lines.push(`! ${warning}`);

    if (lines.length === 0)
      lines.push("（没有产生任何变更）");

    // A zip source was unpacked into a temporary directory that is now spent.
    if (source.isTemp && source.tempRoot)
      await Fsx.remove(source.tempRoot).catch(() => {});

    await Config.save({ lastImportPath: resolved });

    this.app.setStatus(`导入完成：${report.results.length} 个世界`, "ok");
    await this.app.alert("导入完成", lines);

    if (this.onDone)
      await this.onDone()
  }
}

module.exports = ImportWizardScreen;
