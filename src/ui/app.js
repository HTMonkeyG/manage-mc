const { ProcessTerminal, TuiAltScreen, VStack, isViewportTUI, Key, matchesKey } = require("@earendil-works/pi-tui");

const Config = require("../config");
const GameLayout = require("../os/paths");
const WorldRegistry = require("../records/registry");
const Theme = require("./theme");
const HeaderBar = require("./components/headerBar");
const StatusBar = require("./components/statusBar");
const Dialog = require("./components/dialog");

const APP_TITLE = "Minecraft 存档管理器";
const PROGRESS_THROTTLE_MS = 100;

class App {
  /**
   * Application shell: owns the terminal, the layout root and the screen stack.
   * @param {object} [terminal] - Terminal implementation, defaults to the process terminal.
   */
  constructor(terminal) {
    this.terminal = terminal || new ProcessTerminal();
    this.tui = new TuiAltScreen(this.terminal);

    this.config = null;
    this.layout = null;
    this.entries = [];
    this.screen = null;
    this.quitting = false;

    this.header = new HeaderBar();
    this.status = new StatusBar();

    this.header.set(APP_TITLE, "");

    // Ctrl+C is registered on the TUI rather than on a component, because an
    // overlay holding focus would otherwise swallow it.
    this.tui.addInputListener(data => {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.quit();
        return { consume: true }
      }

      // Screen level hotkeys must not fire underneath a modal.
      if (this.tui.hasOverlay())
        return undefined

      return this.screen && this.screen.handleKey ? this.screen.handleKey(data) : undefined
    });
  }

  /**
   * Start the application.
   * @returns {Promise<void>}
   */
  async run() {
    this.config = await Config.load();
    this.tui.start();
    await this.openRoot();
  }

  /**
   * Resolve the configured game root, or ask for one.
   * @returns {Promise<void>}
   */
  async openRoot() {
    var RootSetupScreen = require("./screens/rootSetup")
      , configured = this.config.gameRoot;

    if (configured) {
      try {
        this.layout = await GameLayout.resolve(configured);
      } catch (e) {
        this.layout = null;
        this.setStatus(`无法读取游戏数据目录：${e.message}`, "error");
      }
    }

    if (!this.layout) {
      await this.show(new RootSetupScreen());
      return
    }

    for (var warning of this.layout.warnings)
      this.setStatus(warning, "warn");

    await this.reloadWorlds();
    await this.show(new (require("./screens/worldList"))());
  }

  /**
   * Rebuild the world list from disk.
   * @returns {Promise<void>}
   */
  async reloadWorlds() {
    if (!this.layout) {
      this.entries = [];
      return
    }

    this.entries = await WorldRegistry.build(this.layout, { withMeta: false });
  }

  /**
   * Adopt a new game root and persist it.
   * @param {string} root - Game data root path.
   * @returns {Promise<void>}
   */
  async setRoot(root) {
    this.layout = await GameLayout.resolve(root);
    this.config = await Config.save({
      gameRoot: this.layout.root,
      rootSpelling: this.layout.spelling
    });
  }

  /**
   * Show a screen, replacing the current one.
   * @param {object} screen - Screen to show.
   * @returns {Promise<void>}
   */
  async show(screen) {
    if (this.screen && this.screen.unmount)
      this.screen.unmount();

    this.screen = screen;
    this.status.set("");

    var component = await screen.mount(this);

    this.header.set(screen.title(), screen.subtitle());
    this.status.setHint(screen.hint());

    // The screen's component is mounted as the layout entry itself. Wrapping it
    // in a plain Container would hide a ScrollView from the layout, leaving it
    // with no viewport height and neither wheel nor keyboard scrolling.
    if (isViewportTUI(this.tui)) {
      this.tui.setLayoutRoot(new VStack([
        { component: this.header, basis: 2 },
        { component: component, grow: 1, minSize: 3 },
        { component: this.status, basis: 1 }
      ], { gap: 0 }));
    }

    // Focus is always reassigned, including to null. Leaving the previous
    // screen's focus in place lets that component keep receiving keys it should
    // no longer see, which is how Escape on a screen with no focus target used
    // to reach the world list's cancel handler and quit the application.
    var focus = screen.focus ? screen.focus() : null;

    this.tui.setFocus(focus || null);

    this.tui.requestRender();
  }

  /**
   * Show a status message.
   * @param {string} message - Text to show.
   * @param {string} [kind] - One of info, ok, warn, error, busy.
   * @returns {void}
   */
  setStatus(message, kind) {
    this.status.set(message, kind);
    this.tui.requestRender();
  }

  /**
   * Run a long operation while reporting progress in the status line.
   * @param {string} label - Activity label.
   * @param {function(function(object): void): Promise<any>} task - Work to run, given a reporter.
   * @returns {Promise<any>} Result of the task.
   */
  async withProgress(label, task) {
    var last = 0
      , self = this;

    self.setStatus(label, "busy");

    return task(progress => {
      var now = Date.now();

      if (progress && progress.filesTotal && now - last < PROGRESS_THROTTLE_MS)
        return

      last = now;

      if (!progress || !progress.filesTotal) {
        self.setStatus(label, "busy");
        return
      }

      self.setStatus(
        `${label} ${progress.files}/${progress.filesTotal} · ${Theme.size(progress.bytes)}/${Theme.size(progress.bytesTotal)}`,
        "busy"
      );
    });
  }

  /**
   * Show a modal dialog.
   * @param {object} opts - Dialog options.
   * @returns {Promise<{ok: boolean, value: string}>}
   */
  ask(opts) {
    var self = this;

    return new Promise(resolve => {
      var handle = null
        , dialog = new Dialog(Object.assign({}, opts, {
            done: (ok, value) => {
              // hide() is permanent, so a dialog that may be reopened needs a
              // fresh showOverlay call each time.
              if (handle)
                handle.hide();

              self.tui.requestRender();
              resolve({ ok: ok, value: value });
            }
          }));

      handle = self.tui.showOverlay(dialog, {
        width: "70%",
        minWidth: 40,
        maxHeight: "70%",
        anchor: "center"
      });
    });
  }

  /**
   * Ask the user to confirm an action.
   * @param {string} title - Dialog title.
   * @param {string[]} lines - Body lines.
   * @param {string} [hint] - Hint line.
   * @returns {Promise<boolean>}
   */
  async confirm(title, lines, hint) {
    var result = await this.ask({
      title: title,
      lines: lines,
      hint: hint || "Enter 确认 · Esc 取消"
    });

    return result.ok
  }

  /**
   * Ask the user to confirm a destructive action by typing a phrase.
   * @param {string} title - Dialog title.
   * @param {string[]} lines - Body lines.
   * @param {string} phrase - Text the user must type.
   * @returns {Promise<boolean>}
   */
  async confirmDestructive(title, lines, phrase) {
    var result = await this.ask({
      title: title,
      lines: lines.concat([`请输入 ${Theme.chalk.bold(phrase)} 以确认：`]),
      requireText: phrase,
      placeholder: phrase,
      hint: "输入完全一致后按 Enter · Esc 取消"
    });

    return result.ok
  }

  /**
   * Show a message with a single dismiss action.
   * @param {string} title - Dialog title.
   * @param {string[]} lines - Body lines.
   * @returns {Promise<void>}
   */
  async alert(title, lines) {
    await this.ask({ title: title, lines: lines, hint: "Enter 关闭" });
  }

  /**
   * Leave the application, restoring the terminal.
   * @returns {void}
   */
  quit() {
    if (this.quitting)
      return

    this.quitting = true;
    this.tui.stop();
    process.exit(0);
  }
}

module.exports = App;
