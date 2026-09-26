const { SelectList, Key, matchesKey } = require("@earendil-works/pi-tui");

const UserFolders = require("../../records/users");
const Theme = require("../theme");

// Pseudo row that opens the free-entry dialog rather than toggling a checkbox.
const ADD_ROW = "\u0000add";

const CHECKED = "[x]"
  , UNCHECKED = "[ ]";

class AccountPicker {
  /**
   * Multi-select account picker, shown as an overlay over the import wizard.
   *
   * Only the record's user_ids map is written by an import, so this picks the
   * accounts to record and nothing else. It composes a SelectList rather than
   * inventing a list widget: the checkbox lives in the label and the space key
   * is intercepted here, because the list ignores it.
   * @param {object} opts - Options.
   * @param {object} opts.app - Application shell, used for the add dialog.
   * @param {object[]} opts.candidates - Candidate accounts.
   * @param {string[]} opts.selected - Accounts selected initially.
   * @param {string} [opts.title] - Heading, defaults to 选择账号.
   * @param {string} [opts.hint] - Key hint line.
   * @param {boolean} [opts.allowAdd] - Offer the free-entry row, default true.
   * @param {function(string[]|null): void} opts.done - Chosen accounts, or null when cancelled.
   */
  constructor(opts) {
    this.app = opts.app;
    this.candidates = (opts.candidates || []).slice();
    this.checked = new Set(opts.selected || []);
    this.title = opts.title || "选择账号";
    this.hintText = opts.hint || (opts.allowAdd === false
      ? "空格 勾选 · Enter 继续 · Esc 取消"
      : "空格 勾选 · a 添加账号 · Enter 继续 · Esc 取消");
    this.allowAdd = opts.allowAdd !== false;
    this.done = opts.done;
    this.settled = false;
    this._focused = false;
    this.items = [];

    this.buildItems();
    this.list = new SelectList(this.items, AccountPicker.visibleRows(), Theme.selectList());
  }

  /**
   * Focus state, tracked so the hardware cursor stays hidden over a list.
   * @returns {boolean}
   */
  get focused() {
    return this._focused
  }

  /**
   * Set the focus state.
   * @param {boolean} value - Focus state.
   * @returns {void}
   */
  set focused(value) {
    this._focused = value;
  }

  /**
   * Clear cached render state.
   * @returns {void}
   */
  invalidate() {
    this.list.invalidate();
  }

  /**
   * Rows the picker shows at once.
   * @returns {number}
   */
  static visibleRows() {
    var rows = process.stdout.rows || 24;
    return Math.max(4, Math.floor(rows * 0.8) - 5)
  }

  /**
   * Build the list rows from the candidate set.
   *
   * The SelectList holds this array by reference, so rebuilding in place lets an
   * added account appear without recreating the list.
   * @returns {void}
   */
  buildItems() {
    this.items.length = 0;

    for (var entry of this.candidates) {
      this.items.push({
        value: entry.uid,
        label: `${this.checked.has(entry.uid) ? CHECKED : UNCHECKED} ${entry.uid}`,
        // A caller that supplies its own note is not describing an import.
        description: entry.note || UserFolders.describe(entry)
      });
    }

    if (this.allowAdd)
      this.items.push({
        value: ADD_ROW,
        label: "＋ 添加账号…",
        description: "手动输入要写入 user_ids 的账号"
      });
  }

  /**
   * Repaint the checkbox column after a change.
   * @returns {void}
   */
  refresh() {
    for (var item of this.items) {
      if (item.value === ADD_ROW)
        continue

      item.label = `${this.checked.has(item.value) ? CHECKED : UNCHECKED} ${item.value}`;
    }

    this.app.tui.requestRender();
  }

  /**
   * Handle keyboard input while the overlay holds focus.
   * @param {string} data - Raw key data.
   * @returns {void}
   */
  handleInput(data) {
    if (matchesKey(data, Key.space)) {
      this.toggle();
      return
    }

    if (matchesKey(data, "a")) {
      this.addAccount();
      return
    }

    // Enter is handled here so the add row can open a dialog instead of
    // finishing the selection.
    if (matchesKey(data, Key.enter)) {
      this.submit();
      return
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
      return
    }

    this.list.handleInput(data);
  }

  /**
   * Toggle the highlighted account.
   * @returns {void}
   */
  toggle() {
    var item = this.list.getSelectedItem();

    if (!item || item.value === ADD_ROW)
      return

    if (this.checked.has(item.value))
      this.checked.delete(item.value);
    else
      this.checked.add(item.value);

    this.refresh();
  }

  /**
   * Open a dialog for entering an account id by hand.
   * @returns {Promise<void>}
   */
  async addAccount() {
    var uid = await this.app.prompt(
      "添加账号",
      ["输入要写入该世界 user_ids 的账号 id。"],
      "例如 2878253619"
    );

    if (uid === null)
      return

    if (!UserFolders.isValidId(uid)) {
      this.app.setStatus(`账号 id 无效：${uid}`, "error");
      return
    }

    if (!this.candidates.some(entry => entry.uid === uid))
      this.candidates.push({ uid: uid, active: false, inRecord: false, inSource: false, hasFolder: false });

    this.checked.add(uid);

    var previous = this.list.getSelectedItem();

    this.buildItems();

    if (previous) {
      var index = this.items.findIndex(item => item.value === previous.value);

      if (index >= 0)
        this.list.setSelectedIndex(index);
    }

    this.app.tui.requestRender();
    this.app.setStatus(`已添加账号 ${uid}`, "ok");
  }

  /**
   * Finish with the chosen accounts.
   * @returns {void}
   */
  submit() {
    var item = this.list.getSelectedItem();

    // The add row is a control, not a choice.
    if (item && item.value === ADD_ROW) {
      this.addAccount();
      return
    }

    if (this.settled)
      return

    this.settled = true;
    this.done(Array.from(this.checked));
  }

  /**
   * Abandon the selection.
   * @returns {void}
   */
  cancel() {
    if (this.settled)
      return

    this.settled = true;
    this.done(null);
  }

  /**
   * Render the picker.
   * @param {number} width - Available columns.
   * @returns {string[]}
   */
  render(width) {
    var chalk = Theme.chalk
      , lines = [];

    lines.push(Theme.pad(chalk.bold(this.title) + chalk.dim(`    已选 ${this.checked.size} 个`), width));
    lines.push(Theme.pad(chalk.dim("─".repeat(Math.max(0, width))), width));

    for (var line of this.list.render(width))
      lines.push(line);

    lines.push(Theme.pad(chalk.dim(this.hintText), width));

    return lines
  }
}

module.exports = AccountPicker;
