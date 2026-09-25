const { visibleWidth } = require("@earendil-works/pi-tui");

const Theme = require("../theme");

// The key column is sized to its content but never allowed to crowd out the
// value column.
const MAX_KEY_WIDTH = 22;
const KEY_GAP = 2;

class InfoPanel {
  /**
   * Scrollable key and value listing.
   */
  constructor() {
    this.rows = [];
  }

  /**
   * Replace the rows.
   *
   * A row is one of {section}, {key, value}, or {text}.
   * @param {object[]} rows - Rows to render.
   * @returns {void}
   */
  setRows(rows) {
    this.rows = rows || [];
  }

  /**
   * Clear cached render state.
   * @returns {void}
   */
  invalidate() {
    // Rendered straight from its rows.
  }

  /**
   * Measure the key column.
   * @returns {number}
   */
  keyWidth() {
    var widest = 0;

    for (var row of this.rows) {
      if (!row.key)
        continue

      var width = visibleWidth(Theme.plain(row.key));

      if (width > widest)
        widest = width;
    }

    return Math.min(widest, MAX_KEY_WIDTH)
  }

  /**
   * Render the panel.
   * @param {number} width - Available columns.
   * @returns {string[]}
   */
  render(width) {
    var chalk = Theme.chalk
      , keyWidth = this.keyWidth()
      , lines = [];

    for (var row of this.rows) {
      if (row.section !== undefined) {
        if (lines.length > 0)
          lines.push("");

        lines.push(chalk.bold.cyan(Theme.fit(row.section, width)));
        continue
      }

      if (row.text !== undefined) {
        lines.push(Theme.pad(row.text, width));
        continue
      }

      var key = Theme.pad(chalk.dim(row.key), keyWidth)
        , value = row.style ? row.style(row.value) : String(row.value)
        , prefix = `  ${key}${" ".repeat(KEY_GAP)}`
        , room = width - visibleWidth(Theme.plain(prefix));

      lines.push(prefix + Theme.fit(value, Math.max(0, room)));
    }

    return lines
  }
}

module.exports = InfoPanel;
