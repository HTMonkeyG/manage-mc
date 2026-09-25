const { visibleWidth } = require("@earendil-works/pi-tui");

const Theme = require("../theme");

const RULE = "─";

class HeaderBar {
  /**
   * Fixed header showing the current screen and context.
   */
  constructor() {
    this.title = "";
    this.subtitle = "";
  }

  /**
   * Update the header text.
   * @param {string} title - Primary line.
   * @param {string} [subtitle] - Secondary context.
   * @returns {void}
   */
  set(title, subtitle) {
    this.title = title || "";
    this.subtitle = subtitle || "";
  }

  /**
   * Clear cached render state.
   * @returns {void}
   */
  invalidate() {
    // The header renders straight from its fields, so there is nothing cached.
  }

  /**
   * Render the header.
   * @param {number} width - Available columns.
   * @returns {string[]}
   */
  render(width) {
    var chalk = Theme.chalk
      , left = chalk.bold(this.title)
      , right = this.subtitle ? chalk.dim(` ${this.subtitle}`) : ""
      , used = visibleWidth(Theme.plain(this.title)) + visibleWidth(Theme.plain(this.subtitle)) + 1
      , line = used <= width ? left + right : left;

    return [
      Theme.pad(line, width),
      chalk.dim(RULE.repeat(Math.max(0, width)))
    ]
  }
}

module.exports = HeaderBar;
