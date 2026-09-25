const { Input, Key, matchesKey, visibleWidth } = require("@earendil-works/pi-tui");

const Theme = require("../theme");

const TOP_LEFT = "┌"
  , TOP_RIGHT = "┐"
  , BOTTOM_LEFT = "└"
  , BOTTOM_RIGHT = "┘"
  , HORIZONTAL = "─"
  , VERTICAL = "│";

class Dialog {
  /**
   * Modal dialog rendered inside an overlay.
   *
   * Implements Focusable so the hardware cursor reaches the embedded Input,
   * which is what keeps an IME candidate window in the right place when a
   * confirmation requires typing a world name.
   * @param {object} opts - Dialog options.
   * @param {string} opts.title - Dialog title.
   * @param {string[]} [opts.lines] - Body lines.
   * @param {string} [opts.hint] - Hint shown under the body.
   * @param {string} [opts.requireText] - Text the user must type to confirm.
   * @param {boolean} [opts.freeInput] - Show an input that accepts any value.
   * @param {string} [opts.placeholder] - Placeholder for the input.
   * @param {function(boolean, string): void} opts.done - Called once with the outcome.
   */
  constructor(opts) {
    this.title = opts.title || "";
    this.lines = opts.lines || [];
    this.hint = opts.hint || "";
    this.requireText = opts.requireText === undefined ? null : opts.requireText;
    this.done = opts.done;
    this.settled = false;

    // An input appears when a value is wanted, either as a typed confirmation
    // that has to match or as free text.
    this.input = (this.requireText !== null || opts.freeInput)
      ? new Input({ placeholder: opts.placeholder || "" })
      : null;

    if (this.input)
      this.input.onSubmit = () => this.confirm();

    this._focused = false;
  }

  /**
   * Whether the dialog currently holds focus, forwarded to the input.
   * @returns {boolean}
   */
  get focused() {
    return this._focused
  }

  /**
   * Set focus and propagate it to the input for IME positioning.
   * @param {boolean} value - Focus state.
   * @returns {void}
   */
  set focused(value) {
    this._focused = value;

    if (this.input)
      this.input.focused = value;
  }

  /**
   * Clear cached render state.
   * @returns {void}
   */
  invalidate() {
    if (this.input)
      this.input.invalidate();
  }

  /**
   * Accept the dialog, if the typed confirmation matches.
   * @returns {void}
   */
  confirm() {
    if (this.settled)
      return

    var typed = this.input ? this.input.getValue() : "";

    // A mismatched confirmation deliberately leaves the dialog open rather
    // than reporting an error, so the reason is visible on screen.
    if (this.requireText !== null && typed !== this.requireText)
      return

    this.settled = true;
    this.done(true, typed);
  }

  /**
   * Dismiss the dialog without accepting.
   * @returns {void}
   */
  cancel() {
    if (this.settled)
      return

    this.settled = true;
    this.done(false, this.input ? this.input.getValue() : "");
  }

  /**
   * Handle keyboard input while the overlay holds focus.
   * @param {string} data - Raw key data.
   * @returns {void}
   */
  handleInput(data) {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
      return
    }

    if (this.input) {
      this.input.handleInput(data);
      return
    }

    if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
      this.confirm();
      return
    }

    if (data === "n" || data === "N")
      this.cancel();
  }

  /**
   * Render the dialog box.
   * @param {number} width - Available columns.
   * @returns {string[]}
   */
  render(width) {
    var chalk = Theme.chalk
      , inner = Math.max(1, width - 4)
      , lines = [];

    // Measured in columns, not code units: a Chinese title is two columns per
    // character and would otherwise be truncated to half its length.
    var titleText = ` ${this.title} `
      , titleWidth = Math.min(visibleWidth(Theme.plain(titleText)), inner)
      , fill = Math.max(0, inner - titleWidth);

    lines.push(chalk.dim(TOP_LEFT + HORIZONTAL) + chalk.bold(Theme.fit(titleText, titleWidth)) + chalk.dim(HORIZONTAL.repeat(fill) + TOP_RIGHT));

    for (var body of this.lines)
      lines.push(chalk.dim(VERTICAL) + " " + Theme.pad(body, inner) + " " + chalk.dim(VERTICAL));

    if (this.input) {
      lines.push(chalk.dim(VERTICAL) + " " + Theme.pad("", inner) + " " + chalk.dim(VERTICAL));

      var rendered = this.input.render(inner);

      for (var inputLine of rendered)
        lines.push(chalk.dim(VERTICAL) + " " + Theme.pad(inputLine, inner) + " " + chalk.dim(VERTICAL));
    }

    if (this.hint) {
      lines.push(chalk.dim(VERTICAL) + " " + Theme.pad("", inner) + " " + chalk.dim(VERTICAL));
      lines.push(chalk.dim(VERTICAL) + " " + Theme.pad(chalk.dim(this.hint), inner) + " " + chalk.dim(VERTICAL));
    }

    lines.push(chalk.dim(BOTTOM_LEFT + HORIZONTAL.repeat(Math.max(0, width - 2)) + BOTTOM_RIGHT));

    return lines
  }
}

module.exports = Dialog;
