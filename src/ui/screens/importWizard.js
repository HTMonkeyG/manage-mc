const { Container, Input, Spacer, Text } = require("@earendil-works/pi-tui");

const Config = require("../../config");
const Fsx = require("../../os/fsx");
const SourceDetector = require("../../os/detect");
const WorldImporter = require("../../os/importer");
const UserFolders = require("../../records/users");
const Theme = require("../theme");
const InfoPanel = require("../components/infoPanel");
const AccountPicker = require("../components/accountPicker");
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
   * @param {object} [opts.target] - World entry to replace instead of importing alongside.
   */
  constructor(opts) {
    this.onDone = (opts || {}).onDone;
    this.target = (opts || {}).target || null;
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
    return this.target ? "替换存档" : "导入存档"
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
    return "输入来源路径后按 Enter 识别 · Esc/Ctrl+C 返回"
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
    this.input.setValue("");
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
      { text: "  zip 压缩包" },
      { section: "说明" },
      { text: Theme.chalk.dim("  可以拖放文件夹/压缩包到终端。") },
      { text: Theme.chalk.dim("  记录中的 path 会按目标机器重新计算，不会沿用来源机器的路径。") },
      { text: Theme.chalk.dim("  同名世界默认以副本方式导入，会分配新的 level_id。") },
      { text: Theme.chalk.dim("  导入时会选择账号，写入记录的 user_ids；不会创建账号目录。") }
    ]);

    return this.container
  }

  /**
   * Handle screen level hotkeys.
   * @param {string} data - Raw key data.
   * @returns {object|undefined} Consume result.
   */
  /**
   * Leave this screen, as Escape and Ctrl+C both ask for.
   *
   * A run in progress is aborted rather than merely hidden: the importer removes
   * its staging directory and rolls back when its signal fires, so the target
   * is left as it was.
   * @returns {Promise<void>}
   */
  async cancel() {
    if (this.abort) {
      this.app.setStatus("正在取消导入…", "warn");
      this.abort.abort();
      return
    }

    if (this.busy)
      return

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
    var lines = [];

    if (this.target) {
      lines.push(`将被替换：${Theme.plain(this.target.displayName)}`);
      lines.push(`level_id：${this.target.levelId}`);
      lines.push(Theme.chalk.yellow("替换会覆盖该存档的世界目录、数据库与注册表记录。"));
      lines.push("");
    }

    lines.push(`来源类型：${ImportWizardScreen.kindLabel(source.kind)}`);
    lines.push(`来源路径：${source.rootPath}`);
    lines.push(`识别到 ${source.worlds.length} 个世界`);

    // Replacing uses the first world the source offers; importing alongside
    // uses all of them.
    if (this.target && source.worlds.length > 1) {
      lines.push(`将使用来源中的第一个：${source.worlds[0].levelId}`);
      source = Object.assign({}, source, { worlds: [source.worlds[0]] });
    }

    if (source.worlds.length <= LIST_LIMIT)
      for (var world of source.worlds)
        lines.push(`  · ${world.levelId}${world.worldDir ? "" : "（无世界数据）"}`);

    // A package exported with its databases decrypted has to have them put back,
    // because the client only reads an encrypted database.
    var reencrypt = (source.manifest && Array.isArray(source.manifest.worlds) ? source.manifest.worlds : [])
      .filter(w => w.xor && w.xor.decrypted);

    if (reencrypt.length > 0) {
      lines.push(`数据库：${reencrypt.length} 个世界在导出时被解密，`);
      lines.push("  导入时会用默认密钥 88329851 重新加密。");
    }

    for (var warning of source.warnings)
      lines.push(`! ${warning}`);

    var proceed = await this.app.confirm("确认导入来源", lines, "Enter 继续 · Esc 取消");

    if (!proceed)
      return

    var chosen = await this.chooseAccounts(source);

    if (chosen === null) {
      this.app.setStatus("已取消导入", "warn");
      return
    }

    var plan, preflight;

    try {
      plan = await WorldImporter.plan(this.app.layout, source, {
        // Replacing fixes the destination to the world being replaced, so the
        // ordinary collision policy does not apply.
        onCollision: this.target ? "replace" : this.app.config.import.onCollision,
        targetLevelId: this.target ? this.target.levelId : undefined,
        userIds: chosen
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
   * Ask which accounts the imported worlds should be attached to.
   *
   * The answer is written into each record's user_ids. No account folder is
   * created, so this is the whole of the account handling.
   * @param {object} source - Detected source.
   * @returns {Promise<string[]|null>} Chosen account ids, or null when cancelled.
   */
  async chooseAccounts(source) {
    var context = await UserFolders.context(this.app.layout)
      , merged = new Map()
      , selected = new Set();

    // One selection covers the whole batch: a source holding many worlds is
    // imported for the same account.
    for (var world of source.worlds) {
      var suggestion = UserFolders.suggest(world, context);

      for (var entry of suggestion.candidates) {
        var existing = merged.get(entry.uid);

        if (!existing)
          merged.set(entry.uid, Object.assign({}, entry));
        else {
          existing.inRecord = existing.inRecord || entry.inRecord;
          existing.inSource = existing.inSource || entry.inSource;
          existing.hasFolder = existing.hasFolder || entry.hasFolder;
        }
      }

      for (var uid of suggestion.selected)
        selected.add(uid);
    }

    if (merged.size === 0) {
      // Nothing to offer and nothing to guess, so the user has to name an
      // account or accept an empty user_ids.
      this.app.setStatus("未找到候选账号，可按 a 手动添加", "warn");
    }

    return new Promise(resolve => {
      var picker = new AccountPicker({
        app: this.app,
        candidates: Array.from(merged.values()),
        selected: Array.from(selected),
        done: chosen => {
          handle.hide();
          this.app.tui.requestRender();
          resolve(chosen);
        }
      });

      // Shown through the shell so a Ctrl+C delivered as a signal can reach it.
      var handle = this.app.showModal(picker, {
        width: "76%",
        minWidth: 44,
        maxHeight: "80%",
        anchor: "center"
      });
    });
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

    this.abort = new AbortController();

    try {
      report = await this.app.withProgress("正在导入…", progress => WorldImporter.execute(plan, {
        signal: this.abort.signal,
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
    } finally {
      // Cleared before any return above takes effect, so cancel() falls back to
      // leaving the screen once the run is over.
      this.abort = null;
    }

    await this.app.reloadWorlds();

    var lines = report.results.map(result => {
      var parts = [`· ${Theme.plain(result.record.name)} → ${result.levelId}`];

      if (result.minted)
        parts.push(`（新 id，原 ${result.originalLevelId}）`);

      parts.push(`· 账号 ${result.userIds.length > 0 ? result.userIds.join(", ") : "（无）"}`);

      if (result.xor)
        parts.push(`· 数据库已用默认密钥 ${result.xor.keyAscii} 重新加密（${result.xor.files} 个文件）`);

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
