const GameLayout = require("../os/paths");
const WorldRecord = require("./record");

// Fields the client dereferences unconditionally. Only a synthesized record
// fills these in; a record that came from the game is carried verbatim so that
// unknown and future keys survive a round trip.
const SYNTHETIC_FIELDS = {
  pvp: false,
  locator_bar: false,
  is_season_mod: false,
  allow_pc: true,
  vip_only: false,
  multiple_permission: 1,
  gift_ids: {},
  multiple_privacy: 1,
  mod_version: "",
  auto_upload: false,
  hot_fix_pack_path: null,
  version: 0,
  is_use_lan: true,
  max_member_size: 10,
  is_multiple_game: true,
  min_level: 0,
  close_chatexten_addon: true,
  close_aicmd_addon: true,
  close_pet_addon: true,
  password: "",
  is_hardcore: false,
  addons: {},
  slogan: "一起做建筑",
  resource_packs: {},
  video_info: { fancy_bubbles: false },
  tag_list: []
};

class RecordSchema {
  /**
   * Build the record to write for an imported world.
   * @param {object|null} srcRecord - Verbatim source record, or null to synthesize.
   * @param {object} ctx - Build context.
   * @param {string} ctx.levelId - Effective level id, possibly re-minted.
   * @param {GameLayout} ctx.layout - Target layout.
   * @param {boolean} ctx.worldPresent - Whether a world folder will be written.
   * @param {string[]} [ctx.userIds] - Account ids the user selected.
   * @param {object} [ctx.overrides] - Field overrides chosen by the user.
   * @param {object} [ctx.levelMeta] - level.dat metadata, used for a fallback name.
   * @returns {{record: object, synthesized: boolean, notes: string[]}}
   */
  static buildImported(srcRecord, ctx) {
    var synthesized = !srcRecord || typeof srcRecord !== "object"
      , notes = []
      , overrides = ctx.overrides || {}
      , record = synthesized
          ? RecordSchema.synthesizeBase(ctx)
          : Object.assign({}, srcRecord);

    // A world folder exists locally only when one was actually written, so a
    // registry-only import of an online world keeps is_local false.
    var isLocal = ctx.worldPresent ? true : Boolean(record.is_local)
      , isCopy = synthesized ? false : Boolean(record.is_copy);

    record.level_id = ctx.levelId;
    record.is_local = isLocal;
    record.is_copy = isCopy;

    // The path rule is reproduced, never copied: a source path embeds the
    // machine it came from.
    record.path = WorldRecord.pathFor(ctx.layout, ctx.levelId, isLocal, isCopy);

    record.item_id = RecordSchema.pick(overrides.item_id, record.item_id, "-100");
    record.second_type = RecordSchema.pick(overrides.second_type, record.second_type, -1);
    record.icon = RecordSchema.pick(overrides.icon, record.icon, "0");

    var name = RecordSchema.pick(overrides.name, record.name, null);

    if (!name)
      name = RecordSchema.fallbackName(ctx);

    record.name = name;

    // The client reads user_ids as an object unconditionally.
    record.user_ids = RecordSchema.applyUserIds(record.user_ids, ctx.userIds);

    if (synthesized)
      notes.push("record was generated; the client may rewrite it on first launch");

    return { record: record, synthesized: synthesized, notes: notes }
  }

  /**
   * Build the field set for a world that has no record.
   * @param {object} ctx - Build context.
   * @returns {object}
   */
  static synthesizeBase(ctx) {
    var base = {};

    // Insertion order mirrors a real record so a diff against the client's own
    // output stays readable.
    base.pvp = SYNTHETIC_FIELDS.pvp;
    base.locator_bar = SYNTHETIC_FIELDS.locator_bar;
    base.is_season_mod = SYNTHETIC_FIELDS.is_season_mod;
    base.allow_pc = SYNTHETIC_FIELDS.allow_pc;
    base.vip_only = SYNTHETIC_FIELDS.vip_only;
    base.multiple_permission = SYNTHETIC_FIELDS.multiple_permission;
    base.gift_ids = Object.assign({}, SYNTHETIC_FIELDS.gift_ids);
    base.multiple_privacy = SYNTHETIC_FIELDS.multiple_privacy;
    base.level_id = ctx.levelId;
    base.mod_version = SYNTHETIC_FIELDS.mod_version;
    base.name = "";
    base.auto_upload = SYNTHETIC_FIELDS.auto_upload;
    base.hot_fix_pack_path = SYNTHETIC_FIELDS.hot_fix_pack_path;
    base.version = SYNTHETIC_FIELDS.version;
    base.is_use_lan = SYNTHETIC_FIELDS.is_use_lan;
    base.max_member_size = SYNTHETIC_FIELDS.max_member_size;
    base.second_type = -1;
    base.is_multiple_game = SYNTHETIC_FIELDS.is_multiple_game;
    base.min_level = SYNTHETIC_FIELDS.min_level;
    base.close_chatexten_addon = SYNTHETIC_FIELDS.close_chatexten_addon;
    base.user_ids = {};
    base.item_id = "-100";
    base.path = ctx.levelId;
    base.password = SYNTHETIC_FIELDS.password;
    base.icon = "0";
    base.is_local = true;
    base.is_hardcore = SYNTHETIC_FIELDS.is_hardcore;
    base.addons = Object.assign({}, SYNTHETIC_FIELDS.addons);
    base.slogan = SYNTHETIC_FIELDS.slogan;
    base.close_aicmd_addon = SYNTHETIC_FIELDS.close_aicmd_addon;
    base.close_pet_addon = SYNTHETIC_FIELDS.close_pet_addon;
    base.resource_packs = Object.assign({}, SYNTHETIC_FIELDS.resource_packs);
    base.video_info = Object.assign({}, SYNTHETIC_FIELDS.video_info);
    base.tag_list = [];
    base.is_copy = false;

    return base
  }

  /**
   * Choose the first defined value.
   * @param {any} override - User supplied value.
   * @param {any} existing - Value carried from the source record.
   * @param {any} fallback - Value used when neither is defined.
   * @returns {any}
   */
  static pick(override, existing, fallback) {
    if (override !== undefined && override !== null)
      return override
    if (existing !== undefined && existing !== null)
      return existing
    return fallback
  }

  /**
   * Derive a display name when neither the record nor the user supplied one.
   *
   * Neither direction of synchronisation between record.name and the level.dat
   * LevelName is safe, so this only runs when a name is genuinely absent.
   * @param {object} ctx - Build context.
   * @returns {string}
   */
  static fallbackName(ctx) {
    if (ctx.levelMeta) {
      if (ctx.levelMeta.levelName)
        return ctx.levelMeta.levelName
      if (ctx.levelMeta.levelNameFile)
        return ctx.levelMeta.levelNameFile
    }

    if (ctx.worldDir) {
      var fromDir = GameLayout.sanitizeSegment(ctx.worldDir.split(/[\\/]/).pop(), 64);
      if (fromDir)
        return fromDir
    }

    return ctx.levelId
  }

  /**
   * Reduce a record's account map to the selected accounts.
   *
   * Existing values are carried over untouched so a float timestamp is never
   * rounded; newly added accounts get the current time.
   * @param {object} baseObj - Account map from the source record.
   * @param {string[]|undefined} selected - Selected account ids, or undefined to keep all.
   * @returns {object}
   */
  static applyUserIds(baseObj, selected) {
    var base = RecordSchema.sanitizeUserIds(baseObj);

    if (!Array.isArray(selected))
      return base

    var wanted = new Set(selected)
      , out = {};

    // Original order first, so an untouched record keeps its field layout.
    for (var uid of Object.keys(base))
      if (wanted.has(uid))
        out[uid] = base[uid];

    for (var uid of selected)
      if (out[uid] === undefined)
        out[uid] = Date.now() / 1000;

    return out
  }

  /**
   * Drop account entries that are not usable as a path segment.
   * @param {object} obj - Account map.
   * @returns {object}
   */
  static sanitizeUserIds(obj) {
    var out = {};

    if (!obj || typeof obj !== "object")
      return out

    for (var uid of Object.keys(obj)) {
      if (!GameLayout.isSafeSegment(uid))
        continue

      var value = obj[uid];
      out[uid] = typeof value === "number" ? value : Number(value) || 0;
    }

    return out
  }
}

module.exports = RecordSchema;
