const { Chalk } = require("chalk")
  , { truncateToWidth, visibleWidth } = require("@earendil-works/pi-tui");

const chalk = new Chalk({ level: 3 });

// Real world and account names carry section-sign colour codes, which are
// presentation only and would otherwise corrupt a rendered column.
const SECTION_CODE = /§./g;

// User facing text is Chinese; comments and identifiers stay English.
const STATE_LABELS = {
  registered: "正常",
  unregistered: "未注册",
  online: "在线",
  dangling: "数据缺失",
  error: "记录损坏"
};

const STATE_HINTS = {
  registered: "world data and registry entry are both present",
  unregistered: "the folder exists but the client will not list it without a registry entry",
  online: "a marketplace or rental world; only its registry entry is local",
  dangling: "the registry entry exists but its world folder does not",
  error: "the registry entry could not be parsed"
};

class Theme {
  /**
   * The shared chalk instance, forced to true colour.
   * @returns {object}
   */
  static get chalk() {
    return chalk
  }

  /**
   * Strip section-sign colour codes from a name.
   * @param {any} text - Raw text.
   * @returns {string}
   */
  static plain(text) {
    if (text === null || text === undefined)
      return ""

    return String(text).replace(SECTION_CODE, "")
  }

  /**
   * Truncate text to a column width, ignoring escape sequences.
   * @param {string} text - Text to fit.
   * @param {number} width - Available columns.
   * @returns {string}
   */
  static fit(text, width) {
    if (width <= 0)
      return ""

    return truncateToWidth(String(text), width, "…")
  }

  /**
   * Pad text to a column width.
   * @param {string} text - Text to pad.
   * @param {number} width - Target columns.
   * @returns {string}
   */
  static pad(text, width) {
    var line = Theme.fit(text, width)
      , missing = width - visibleWidth(line);

    return missing > 0 ? line + " ".repeat(missing) : line
  }

  /**
   * Render the label for a world state.
   * @param {string} state - World state.
   * @returns {string}
   */
  static stateLabel(state) {
    return STATE_LABELS[state] || state
  }

  /**
   * Explain a world state in one line.
   * @param {string} state - World state.
   * @returns {string}
   */
  static stateHint(state) {
    return STATE_HINTS[state] || ""
  }

  /**
   * Colour the label for a world state.
   * @param {string} state - World state.
   * @returns {string}
   */
  static badge(state) {
    var label = Theme.stateLabel(state);

    switch (state) {
      case "registered":
        return chalk.green(label)
      case "unregistered":
        return chalk.yellow(label)
      case "online":
        return chalk.cyan(label)
      case "dangling":
        return chalk.red(label)
      default:
        return chalk.magenta(label)
    }
  }

  /**
   * Format a byte count.
   * @param {number|null} bytes - Size in bytes.
   * @returns {string}
   */
  static size(bytes) {
    if (bytes === null || bytes === undefined)
      return "—"

    var units = ["B", "KB", "MB", "GB", "TB"]
      , value = bytes
      , unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }

    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
  }

  /**
   * Format a unix timestamp in seconds.
   * @param {number|null} seconds - Unix time in seconds.
   * @returns {string}
   */
  static time(seconds) {
    if (!seconds)
      return "—"

    var d = new Date(seconds * 1000)
      , pad = n => String(n).padStart(2, "0");

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  /**
   * Theme for SelectList.
   * @returns {object}
   */
  static selectList() {
    return {
      selectedPrefix: text => chalk.cyan(text),
      selectedText: text => chalk.bold.white(text),
      description: text => chalk.dim(text),
      scrollInfo: text => chalk.dim(text),
      noMatch: text => chalk.dim(text)
    }
  }

  /**
   * Theme for SettingsList.
   * @returns {object}
   */
  static settingsList() {
    return {
      label: (text, selected) => selected ? chalk.bold.white(text) : text,
      value: (text, selected) => selected ? chalk.cyan(text) : chalk.dim(text),
      description: text => chalk.dim(text),
      cursor: chalk.cyan("> "),
      hint: text => chalk.dim(text)
    }
  }

  /**
   * Theme for the Editor and Input components.
   * @returns {object}
   */
  static editor() {
    return {
      borderColor: text => chalk.dim(text),
      selectList: Theme.selectList()
    }
  }
}

module.exports = Theme;
