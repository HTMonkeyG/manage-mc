const os = require("os")
  , path = require("path");

const { Container, Input, Spacer, Text } = require("@earendil-works/pi-tui");

const Fsx = require("../../os/fsx");
const GameLayout = require("../../os/paths");
const WorldRecord = require("../../records/record");
const Theme = require("../theme");
const InfoPanel = require("../components/infoPanel");

// Install locations the NetEase client uses, probed so the common case needs no
// typing.
const CANDIDATE_NAMES = [
  "MinecraftPC_Netease_PB",
  "MinecraftPC_Netease",
  "MinecraftPE_Netease",
  "MinecraftPC"
];

class RootSetupScreen {
  /**
   * First run screen: choose the game data folder.
   */
  constructor() {
    this.app = null;
    this.container = new Container();
    this.input = new Input({
      prompt: "目录 > ",
      placeholder: "E:/path/to/MinecraftPC_Netease_PB"
    });
    this.info = new InfoPanel();
  }

  /**
   * Screen title.
   * @returns {string}
   */
  title() {
    return "设置游戏数据目录"
  }

  /**
   * Screen subtitle.
   * @returns {string}
   */
  subtitle() {
    return "首次运行"
  }

  /**
   * Key hint.
   * @returns {string}
   */
  hint() {
    // On first run there is no world list to return to, so this screen stands
    // in for the main one and Ctrl+C is the only way out.
    return this.isMainScreen()
      ? "输入目录后按 Enter 校验并保存 · Ctrl+C 退出"
      : "输入目录后按 Enter 校验并保存 · Esc/Ctrl+C 返回"
  }

  /**
   * Whether this screen is standing in for the main one.
   *
   * Changing an existing root returns to the world list, so the main screen is
   * still behind it. With no root configured yet there is nothing behind it and
   * this screen becomes the root, which is what makes Ctrl+C able to quit.
   * @returns {boolean}
   */
  isMainScreen() {
    return !(this.app && this.app.layout)
  }

  /**
   * Abandon the change and return to the world list.
   * @returns {Promise<void>}
   */
  async cancel() {
    var WorldListScreen = require("./worldList");

    await this.app.show(new WorldListScreen());
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

    this.input.setValue(app.config.gameRoot || await RootSetupScreen.guessRoot());
    this.input.onSubmit = value => this.submit(value);

    this.container.addChild(new Text("请指定网易版 Minecraft 的游戏数据目录。", 0, 0));
    this.container.addChild(new Text("该目录应包含 minecraftWorlds 与 storage（或 storge）。", 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.input);
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.info);

    this.info.setRows([
      { text: Theme.chalk.dim("输入路径后按 Enter。目录会被校验，并在写入前确认。") }
    ]);

    return this.container
  }

  /**
   * Probe the usual install locations.
   * @returns {Promise<string>} A path that exists, or an empty string.
   */
  static async guessRoot() {
    var roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

    for (var name of CANDIDATE_NAMES) {
      var candidate = path.join(roaming, name);

      if (await Fsx.existsDir(candidate))
        return candidate
    }

    return ""
  }

  /**
   * Expand a leading tilde and resolve the rest.
   * @param {string} value - Raw user input.
   * @returns {string} Absolute path.
   */
  static expand(value) {
    var trimmed = String(value || "").trim().replace(/^"|"$/g, "");

    if (trimmed === "~")
      return os.homedir()

    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\"))
      return path.join(os.homedir(), trimmed.slice(2))

    return path.resolve(trimmed)
  }

  /**
   * Validate the typed path and adopt it.
   * @param {string} value - Raw user input.
   * @returns {Promise<void>}
   */
  async submit(value) {
    var raw = String(value || "").trim();

    if (!raw) {
      this.app.setStatus("请输入游戏数据目录路径", "warn");
      return
    }

    var resolved = RootSetupScreen.expand(raw);

    if (!(await Fsx.existsDir(resolved))) {
      this.app.setStatus(`目录不存在：${resolved}`, "error");
      return
    }

    var layout;

    try {
      layout = await GameLayout.resolve(resolved);
    } catch (e) {
      this.app.setStatus(e.message, "error");
      return
    }

    var records = await WorldRecord.list(layout)
      , worlds = await Fsx.listDirs(layout.minecraftWorlds)
      , hasWorlds = await Fsx.existsDir(layout.minecraftWorlds);

    if (!hasWorlds) {
      var proceed = await this.app.confirm("缺少 minecraftWorlds", [
        `所选目录：${resolved}`,
        "该目录下没有 minecraftWorlds 子目录。",
        "继续使用会在首次导入时创建它。"
      ], "Enter 继续 · Esc 返回");

      if (!proceed)
        return
    }

    await this.app.setRoot(resolved);

    this.app.setStatus(
      `已设置：存档库 ${layout.spelling} · 世界目录 ${worlds.length} 个 · 注册表 ${records.length} 条`,
      "ok"
    );

    await this.app.reloadWorlds();

    var WorldListScreen = require("./worldList");
    await this.app.show(new WorldListScreen());
  }
}

module.exports = RootSetupScreen;
