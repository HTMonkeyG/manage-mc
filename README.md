# manage-mc

一个《我的世界》存档管理器：以全屏终端界面列出、导入和导出游戏数据目录中的
存档。面向网易 PC 版，同时支持国际版存档的 XOR 加密数据库（见
[加密数据库](#加密数据库国际版)）。

界面基于 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)，
读取 `level.dat` 使用
[`parsenbt-js`](https://www.npmjs.com/package/parsenbt-js)，MCBE NBT 模板来自
[`project-mirror-registry`](https://www.npmjs.com/package/project-mirror-registry)。

## 安装与运行

安装需要 Node 22.19 或更高版本：

```sh
npm i @htmonkeyg/manage-mc
```

运行输入：

```sh
mngmc
```

## 用法

首次运行时，程序会询问游戏数据目录，之后将其记录在 `~/.manage-mc.json` 中。

| 按键 | 操作 |
| --- | --- |
| `Enter` | 打开所选存档的详情 |
| `i` | 导入存档 |
| `e` | 导出所选存档 |
| `E` | 导出所有存在本地数据的存档 |
| `p` | 为没有注册表条目的存档目录建立注册 |
| `r` | 从磁盘重新读取全部内容 |
| `s` | 设置 |
| `q` | 退出 |

在详情界面中，`↑`/`↓`/`Home`/`End` 以及鼠标滚轮用于滚动面板，
`PageUp`/`PageDown` 按页滚动，`e` 导出，`b` 返回 —— 返回后光标仍停留在原来的
存档上。

`Esc` 始终表示“上一级”，从不退出：在详情、导入和导出界面中它用于返回，而在
存档列表上它不做任何事，因为列表之上已无层级。`q` 和 `Ctrl+C` 是仅有的退出
方式。

### 导入来源

导入器依据内容识别路径，因此以下各类均可用：

- 本工具生成的包（包含 `manifest.json`）
- 单个存档目录（包含 `level.dat`）
- 一个 `minecraftWorlds` 目录，或整个游戏数据目录
- 仅含注册表的存储目录
- 上述任意一种的 `.zip` 压缩包

导入时会重写记录：`path` 字段会按目标安装位置重新计算，因此跨机器迁移的存档
不会再指向它原来所在的机器。若某存档的 id 已存在，则会以一个全新生成的 id
作为副本导入。

### 选择账号

识别出来源后，会有一个选择器询问导入的存档应关联到哪些账号。结果会以
`account: timestamp` 的形式写入每条记录的 `user_ids` 映射。

- 默认选中**当前账号**（`storage/stream/users/last_user_id`），因为从其他机器
  带来的存档必须先关联到本机账号，客户端才会列出它。
- 其他候选包括来源记录中已有的账号，以及本机已知的账号。每一行都会标明它的
  来源。
- `Space` 切换选中，`a` 手动添加账号，`Enter` 继续，`Esc` 放弃导入。
- 来源记录中已存在的时间戳会原样保留；新添加的账号使用当前时间。若一个都不
  选，则写入空的 `user_ids`。

只写入记录本身。导入**不会**创建或修改账号目录
（`storage/stream/users/<uid>/<world>/`）—— 客户端会在首次启动时自行创建它们。

### 导出结构

一次导出得到的是一份不完整的游戏根目录，因此既能手动查看，也能再次导入：

```
<name>/
  manifest.json                                  包内包含的内容
  minecraftWorlds/<level_id>/                    存档，逐字节复制
  storage/stream/resource_management/world_records/<level_id>.json
  storage/stream/users/<uid>/<level_id>/         各账号目录
```

请用本工具导入，而不要手动复制到位：记录中的 `path` 字段仍指向导出它的那台
机器，只有导入器会重写它。

### 加密数据库（国际版）

客户端把存档的 LevelDB 存放在 `db/` 下，并对其中一部分文件做 XOR 加密。加密
文件以 32 位魔数 `80 1D 30 01` 开头，内容与一个 8 字节周期密钥异或。客户端自身
使用的密钥是 ASCII 字符串 `88329851`，存档也可能携带自定义密钥。

**导出时解密，导入时重新加密。**

- 导出时的密钥是**推断**出来的，而非假定。LevelDB 的 `CURRENT` 文件内容就是
  MANIFEST 的文件名，而文件名本身从不加密，因此 MANIFEST 名与加密后的 `CURRENT`
  构成一对已知明文 —— 二者异或即得密钥。推断结果还会被双重确认：密钥必须在整个
  文件上以预期周期重复，且解密后的表必须复原每个 LevelDB 表末尾的标记。
- 推断出的密钥以及它实际覆盖的文件清单会写入包的 `manifest.json` 的 `xor` 字段，
  同时给出 hex 与 ASCII 两种形式。
- 导入时这些文件会用**默认密钥**重新加密，因为客户端用的就是它，所以重新导入的
  存档与导出前的原存档逐字节一致。
- 以记录的文件清单为准，而不是按文件名规则：`.log` 文件客户端**不加密**，加密它
  会破坏数据库。

本来就是明文的数据库在导入导出两个方向都不会被改动；无法推断出密钥的也一样
（此时导出会保持加密并记录原因）。在设置中关闭解密即可得到逐字节原样的归档。

存档详情界面会显示加密状态、推断出的密钥，以及密钥是否通过校验。

## 存档状态

游戏把 `world_records` 当作注册表、把 `minecraftWorlds` 当作数据，二者并不
必须一致。列表中会标出每一项属于哪种情况：

| 状态 | 含义 |
| --- | --- |
| 正常 (registered) | 目录与注册表条目均存在 |
| 未注册 (unregistered) | 目录存在但没有注册表条目 —— 在写入条目之前游戏不会列出它；按 `p` 注册 |
| 在线 (online) | 市场或租赁存档；本地只有它的注册表条目 |
| 数据缺失 (dangling) | 注册表条目存在但目录已消失。从磁盘删除存档时常见的情况 |
| 记录损坏 (error) | 注册表条目无法解析 |

## 说明与限制

- `db/` 是 LevelDB，从不被解析、查询或压缩，只会整体复制。唯一会被改写的情形是
  XOR 加解密（见上）：导出时按推断出的密钥解密，导入时用默认密钥加密。关闭该
  功能后 `db/` 就是完全逐字节复制。
- `level.dat` 只读。本工具会显示 `LevelName`、`LastPlayed`、`RandomSeed` 等
  字段，但从不写入该文件。注意 `record.name` 与 `level.dat` 的 `LevelName` 是
  用途不同的两个值，因此有意不做同步。
- 不管理账号状态：导入只写入记录的 `user_ids`，别的什么都不做。因此以新 id
  重新导入存档无法更新 `users/<uid>/last_play_data`，即客户端“继续上次存档”的
  指针。导入会报告受影响的账号；客户端对这些账号会回退到存档列表。导出则正好
  相反 —— 它收集已存在的各账号存档目录，因此带有账号状态的存档会保留该状态。
- 记录引用的附加包与资源包存放在存档目录之外
  （`resource_management/addon_records`、`addon_location`），因此不会被导出
  带走，跨机器迁移的存档可能会缺失它们。
- zip 由 `adm-zip` 在内存中组装；对于数百兆字节的存档请使用文件夹格式。

## 目录结构

```
src/
  main.js                 入口
  config.js               ~/.manage-mc.json
  os/
    paths.js              游戏目录解析（storage 与 storge）、路径安全
    fsx.js                目录遍历、分阶段复制、原子写入
    pack.js               zip 打包
    leveldat.js           只读解析 level.dat
    xorenc.js             db 的 XOR 加解密与密钥推断
    detect.js             导入来源分类
    importer.js           导入的规划、预检与执行
    exporter.js           导出的规划与执行
  records/
    levelid.js            level id 校验、生成与冲突探测
    record.js             注册表条目的读写
    schema.js             导入存档的记录字段规则
    registry.js           目录/注册表外连接与存档状态
    users.js              各账号目录的规划
  ui/
    app.js                终端外壳、界面栈、对话框
    theme.js              配色与文本宽度测量
    components/           头部、状态栏、信息面板、对话框
    screens/              初始化、存档列表、详情、导入、导出、设置
```

## 示例数据

`reference/example/MinecraftPC_Netease_PB` 是用于开发的示例游戏数据目录，其
`db/` 恰好是用默认密钥 `88329851` 加密的，可直接用于验证加解密链路。它是只读
参考：试验前请先复制一份，因为导入会写入目标目录。

`reference/main.js` 与 `reference/XOREncryptHelper.js` 是加解密方案的参考实现。
