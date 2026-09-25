# manage-mc

A Minecraft (NetEase PC edition) world manager: a full-screen terminal UI for
listing, importing and exporting worlds in a game data folder.

Built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)
for the interface, [`parsenbt-js`](https://www.npmjs.com/package/parsenbt-js) for
reading `level.dat`, and [`project-mirror-registry`](https://www.npmjs.com/package/project-mirror-registry)
for MCBE NBT templates.

## Install and run

```sh
npm install
npm start
```

Requires Node 22.19 or newer. `npm install` pulls in `adm-zip`, which is used
for zip import and export; folder import and export use no external library.

## Usage

On first run the app asks for the game data folder, then remembers it in
`~/.manage-mc.json`.

| Key | Action |
| --- | --- |
| `Enter` | Open the selected world's details |
| `i` | Import a world |
| `e` | Export the selected world |
| `E` | Export every world that has local data |
| `p` | Register a world folder that has no registry entry |
| `r` | Re-read everything from disk |
| `s` | Settings |
| `q` | Quit |

On the detail screen, `↑`/`↓`/`Home`/`End` and the mouse wheel scroll the
panel, `PageUp`/`PageDown` scroll by a page, `e` exports and `b` goes back —
returning with the cursor still on the same world.

`Esc` always means "go up one level" and never quits: on the detail, import and
export screens it goes back, and on the world list it does nothing, since there
is no level above it. `q` and `Ctrl+C` are the only ways to quit.

### Import sources

The importer recognises a path by its contents, so any of these work:

- a package produced by this tool (contains `manifest.json`)
- a single world folder (contains `level.dat`)
- a `minecraftWorlds` folder, or a whole game data folder
- a storage folder carrying only the registry
- a `.zip` of any of the above

Records are rewritten on import: the `path` field is recomputed for the target
installation, so a world moved between machines does not keep pointing at the
machine it came from. A world whose id already exists is imported as a copy
under a newly minted id.

### Choosing accounts

After the source is recognised, a picker asks which accounts the imported
worlds should be attached to. The answer is written into each record's
`user_ids` map as `account: timestamp`.

- The **active account** (`storage/stream/users/last_user_id`) is selected by
  default, since a world brought from another machine has to be attached to an
  account here before the client lists it.
- Other candidates are the accounts the source record names and the accounts
  this machine already knows about. Each row says where it came from.
- `Space` toggles, `a` adds an account by hand, `Enter` continues, `Esc`
  abandons the import.
- A timestamp already present in the source record is carried over untouched;
  a newly added account gets the current time. Selecting nothing writes an
  empty `user_ids`.

Only the record is written. Account folders
(`storage/stream/users/<uid>/<world>/`) are **not** created or modified by an
import — the client builds them itself on first launch.

### Export layout

An export is a partial game root, so it can be read by hand as well as
reimported:

```
<name>/
  manifest.json                                  what the package contains
  minecraftWorlds/<level_id>/                    the world, copied byte for byte
  storage/stream/resource_management/world_records/<level_id>.json
  storage/stream/users/<uid>/<level_id>/         per-account folders
```

Import it with this tool rather than copying it into place by hand: the
`path` field inside the record still names the machine it was exported from,
and the importer is what rewrites it.

## World states

The game treats `world_records` as a registry and `minecraftWorlds` as the
data, and the two do not have to agree. The list shows which case each entry
is:

| State | Meaning |
| --- | --- |
| 正常 (registered) | Folder and registry entry both present |
| 未注册 (unregistered) | Folder present, no registry entry — the game will not list it until one is written; press `p` to register it |
| 在线 (online) | Marketplace or rental world; only its registry entry is local |
| 数据缺失 (dangling) | Registry entry present, folder gone. The common case for a world deleted from disk |
| 记录损坏 (error) | The registry entry could not be parsed |

## Notes and limitations

- `db/` is LevelDB and is copied as opaque bytes. It is never opened, parsed or
  compacted.
- `level.dat` is read-only. The tool displays `LevelName`, `LastPlayed`,
  `RandomSeed` and similar fields, but never writes the file. Note that
  `record.name` and `level.dat`'s `LevelName` are different values with
  different purposes, so they are deliberately not synchronised.
- Account state is not managed: an import writes the record's `user_ids` and
  nothing else. So re-importing a world under a new id cannot update
  `users/<uid>/last_play_data`, the client's "continue last world" pointer. The
  import reports which accounts are affected; the client falls back to the world
  list for them. Export is the mirror image — it collects the per-account world
  folders that already exist, so a world carrying account state keeps it.
- Addons and resource packs referenced by a record live outside the world folder
  (`resource_management/addon_records`, `addon_location`), so they are not
  carried by an export and a world moved between machines may be missing them.
- A zip is assembled in memory by `adm-zip`; use the folder format for worlds of
  several hundred megabytes.

## Layout

```
src/
  main.js                 entry point
  config.js               ~/.manage-mc.json
  os/
    paths.js              game layout resolution (storage vs storge), path safety
    fsx.js                tree walking, staged copies, atomic writes
    pack.js               zip packaging
    leveldat.js           read-only level.dat parsing
    detect.js             import source classification
    importer.js           import planning, preflight and execution
    exporter.js           export planning and execution
  records/
    levelid.js            level id validation, minting, collision probing
    record.js             registry entry read and write
    schema.js             record field rules for imported worlds
    registry.js           folder/registry outer join and world states
    users.js              per-account folder planning
  ui/
    app.js                terminal shell, screen stack, dialogs
    theme.js              colours and text measurement
    components/           header, status bar, info panel, dialog
    screens/              setup, world list, detail, import, export, settings
```

## Example data

`example/MinecraftPC_Netease_PB` is a sample game data folder used for
development. It is a read-only reference: copy it before experimenting, since
imports write into the target folder.
