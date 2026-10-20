# WorkBuddy 每日签到助手 (workbuddy-checkin-helper)

一键完成 WorkBuddy「Buddy 加油站」每日积分签到与派猫猫旅行。自动读取本机 WorkBuddy 桌面端登录态、幂等防重复领取、绝不打印或外泄任何 token。

> **作者**:xifan · **开源仓库**:https://github.com/xifanCode/workBuddyIntegral
> **License**:MIT(转载/二次分发请保留本声明与源码中的版权信息)

## 类型
Agent 型(单个 AI 专家)

## 功能
- 每日积分签到(查状态 → 未签才领,幂等)
- 派猫猫旅行(领已到家的旅行礼物 → 判断是否派新一趟)
- 登录态自检(`--doctor` 模式,离线、不联网)

## 依赖(仅此一项)
- **必须安装并登录 WorkBuddy 桌面端**——脚本用它自带的 Electron 二进制作为 JS 运行时,并就地解密加密登录态。
- **不需要 Python,也不需要单独安装 Node。**

> 说明:解密 sym-v1 加密凭据所需的原生存储绑定(`electron_browser_workbuddy_storage`)
> 只存在于 WorkBuddy 桌面端的 Electron 二进制中,纯 node 没有。因此脚本以
> `ELECTRON_RUN_AS_NODE=1 <Electron可执行文件> wb_buddy_auto.js` 运行;
> 若用 `node wb_buddy_auto.js` 启动,脚本会自动寻找并重启到该二进制,效果相同。

## 使用方式
直接对专家说:
- 「帮我完成今天的 WorkBuddy 签到和派猫猫旅行」
- 「检查我的登录态是否有效(诊断模式)」
- 「帮我配置一个每天定时自动签到的任务」

专家会自动定位 `bin/wb_buddy_auto.js` 与 WorkBuddy 运行时并运行,解析脱敏后的 JSON 结果后,用一行中文汇报「签到」与「猫猫」两段结论。

### 手动运行
```bash
# 方式一:让脚本自己找运行时(最省事)
node bin/wb_buddy_auto.js

# 方式二:显式指定 WorkBuddy 桌面端可执行文件
ELECTRON_RUN_AS_NODE=1 "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy" bin/wb_buddy_auto.js

# 方式三:本地调度入口(launchd / cron 共用,自动选运行时)
./bin/run_local.sh

# 离线自检(不解密、不联网)
node bin/wb_buddy_auto.js --doctor
```

## 文件说明
| 文件 | 作用 |
|------|------|
| `bin/wb_buddy_auto.js` | 主脚本(Node.js,零第三方依赖) |
| `bin/run_local.sh` | 本地调度入口,自动选择运行时并写日志 |
| `bin/wb_buddy_auto.py` | 旧版 Python 实现,仅作兼容保留,不再需要 |

## 头像
头像自动生成于 `avatars/expert.jpg`。如需替换,要求:PNG/JPG、512×512、≤500KB。

## 合规与稳定性提示
- 本专家包调用的签到接口为非公开接口(逆向自桌面端),官方可能调整;接口变更时需更新内置脚本。
- 脚本仅读取**当前用户本机**登录态,不收集、不上传任何凭据;分享给他人的只是脚本本身,不含你的个人 token。

## 安装(本地)
专家包已置于专家目录:
```
~/.workbuddy/plugins/marketplaces/my-experts/plugins/workbuddy-checkin-helper/
```
运行注册命令使其对 WorkBuddy 可见:
```bash
python3 scripts/register_expert.py <expert-dir>
```

## 打包分享
```bash
python3 scripts/package_expert.py <expert-dir>
```
