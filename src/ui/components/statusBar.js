const Theme = require("../theme");

const KIND_STYLES = {
  info: text => Theme.chalk.dim(text),
  ok: text => Theme.chalk.green(text),
  warn: text => Theme.chalk.yellow(text),
  error: text => Theme.chalk.red(text),
  busy: text => Theme.chalk.cyan(text)
};

class StatusBar {
  /**
   * Single line footer carrying the latest message or the key hints.
   */
  constructor() {
    this.message = "";
    this.kind = "info";
    this.hint = "";
  }

  /**
   * Show a message.
   * @param {string} message - Text to show.
   * @param {string} [kind] - One of info, ok, warn, error, busy.
   * @returns {void}
   */
  set(message, kind) {
    this.message = message || "";
    this.kind = KIND_STYLES[kind] ? kind : "info";
  }

  /**
   * Show the key hints used when no message is pending.
   * @param {string} hint - Hint text.
   * @returns {void}
   */
  setHint(hint) {
    this.hint = hint || "";
  }

  /**
   * Clear cached render state.
   * @returns {void}
   */
  invalidate() {
    // Rendered straight from its fields.
  }

  /**
   * Render the status line.
   * @param {number} width - Available columns.
   * @returns {string[]}
   */
  render(width) {
    var text = this.message || Theme.plain(this.hint)
      , style = this.message ? KIND_STYLES[this.kind] : KIND_STYLES.info;

    return [Theme.pad(style(text), width)]
  }
}

module.exports = StatusBar;
