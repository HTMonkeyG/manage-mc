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

// Two deliveries of one Ctrl+C arrive within a few milliseconds of each other.
// Well above that, and still far below the gap between two deliberate presses.
const INTERRUPT_DEDUPE_MS = 120;

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
    this.modal = null;
    this.signalHandler = null;
    this.lastInterruptAt = 0;

    this.header = new HeaderBar();
    this.status = new StatusBar();

    this.header.set(APP_TITLE, "");

    // Both cancel gestures are registered on the TUI rather than on a
    // component, because an overlay holding focus would otherwise swallow them.
    // Routing them here keeps one rule for the whole application instead of a
    // clause in every screen.
    this.tui.addInputListener(data => {
      // A modal owns the keyboard, cancel gestures included: it decides for
      // itself what Escape and Ctrl+C mean while it is open.
      if (this.tui.hasOverlay())
        return undefined

      var isEscape = matchesKey(data, Key.escape)
        , isQuit = matchesKey(data, Key.ctrl("c"));

      if (!isEscape && !isQuit)
        return this.screen && this.screen.handleKey ? this.screen.handleKey(data) : undefined

      if (isQuit)
        this.handleInterrupt();
      else
        this.cancelScreen();

      return { consume: true }
    });

    // Raw mode normally turns Ctrl+C into an ordinary key press, but a terminal
    // that still delivers the signal would kill the process outright and skip
    // the rule above entirely. Handling the signal keeps both delivery paths
    // behaving the same. They cannot both fire for one press: the signal only
    // exists when raw mode is not suppressing it, and then no key data is
    // produced.
    this.signalHandler = () => this.handleInterrupt();
    process.on("SIGINT", this.signalHandler);
  }

  /**
   * Apply the Ctrl+C rule.
   *
   * The main screen has no level above it, so there is nothing to cancel back
   * to and Ctrl+C quits. Everywhere else it cancels, exactly as Escape does.
   * @returns {void}
   */
  handleInterrupt() {
    // A terminal can hand the same Ctrl+C over twice, once as a key and once as
    // a signal. Acting on both would cancel and then immediately quit, because
    // the first cancel lands on the main screen where the rule is to exit. Two
    // real presses are never this close together.
    var now = Date.now();

    if (now - this.lastInterruptAt < INTERRUPT_DEDUPE_MS)
      return

    this.lastInterruptAt = now;

    // A modal owns the keyboard, so it takes the interrupt first. The signal
    // path has no focus dispatch of its own, which is why the modal is tracked.
    if (this.modal && this.modal.cancel) {
      this.modal.cancel();
      return
    }

    var screen = this.screen;

    if (screen && screen.cancel && !(screen.isMainScreen && screen.isMainScreen())) {
      screen.cancel();
      return
    }

    this.quit();
  }

  /**
   * Leave the current screen the way Escape does, quitting if it is the root.
   * @returns {void}
   */
  cancelScreen() {
    if (this.screen && this.screen.cancel && !(this.screen.isMainScreen && this.screen.isMainScreen())) {
      this.screen.cancel();
      return
    }

    // On the main screen Escape has no meaning, so nothing happens.
  }

  /**
   * Show a component as a modal, remembering it.
   *
   * The reference is what lets a Ctrl+C delivered as a signal reach the modal,
   * since a signal has no focus dispatch behind it.
   * @param {object} component - Component to show.
   * @param {object} [options] - Overlay options.
   * @returns {object} Overlay handle whose hide() also clears the reference.
   */
  showModal(component, options) {
    var self = this
      , handle = this.tui.showOverlay(component, options);

    self.modal = component;

    return {
      hide: () => {
        if (self.modal === component)
          self.modal = null;

        handle.hide();
      }
    }
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

    // Metadata is read here because the list shows a last played time, and only
    // level.dat carries the real one. The sort is applied by the registry so
    // that it sees the same values.
    this.entries = await WorldRegistry.build(this.layout, {
      withMeta: true,
      sort: this.config.ui.worldSort
    });
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

      handle = self.showModal(dialog, {
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
   * Ask the user for a line of text.
   * @param {string} title - Dialog title.
   * @param {string[]} lines - Body lines.
   * @param {string} [placeholder] - Input placeholder.
   * @returns {Promise<string|null>} Entered text, or null when cancelled or blank.
   */
  async prompt(title, lines, placeholder) {
    var result = await this.ask({
      title: title,
      lines: lines,
      freeInput: true,
      placeholder: placeholder || "",
      hint: "Enter 确认 · Esc 取消"
    });

    if (!result.ok)
      return null

    return result.value.trim() || null
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

    // Left installed, the handler would keep firing against a torn-down shell.
    if (this.signalHandler)
      process.removeListener("SIGINT", this.signalHandler);

    this.tui.stop();
    process.exit(0);
  }
}

module.exports = App;
