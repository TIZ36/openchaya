# 分发与签名 (macOS) — 解决「Chaya is damaged」

## 为什么会报 "Chaya is damaged and can't be opened"

不是安装包损坏。这是 macOS Gatekeeper 的提示:**应用没有用 Apple Developer ID 签名、也没有公证 (notarize)**。
从网上/AirDrop/聊天工具下载的 app 会被打上 `com.apple.quarantine` 隔离属性;在 **Apple 芯片 (M 系列)** 上,**未签名**的二进制会被直接判定为 "damaged"(未签名 app 在 arm64 上无法运行)。

签名状态对应的提示:
- **未签名** → "is damaged"(致命,双击直接拒)
- **ad-hoc 签名**(本仓库现在的默认)→ "unidentified developer"(可右键打开)
- **Developer ID 签名 + 公证** → 无任何提示,正常打开 ✅

---

## 立刻可用:让对方打开已经拿到的安装包(无需重新打包)

把 app 拖进「应用程序」后,终端执行(去掉隔离属性):

```bash
xattr -cr /Applications/Chaya.app
```

然后正常双击即可。或者:**右键 Chaya.app → 打开**(若是 ad-hoc 签名的新包,这样就行;旧的未签名包用上面的 `xattr` 命令)。

> 如果对方拿到的是 `.dmg`:先把 Chaya 拖到「应用程序」,再对 `/Applications/Chaya.app` 跑 `xattr -cr`。

---

## 重新打包后的默认行为(本仓库已配置)

`pnpm electron:build` 现在会:
- 没配 Developer ID 时 → `build/afterPack.cjs` 对 .app 做 **ad-hoc 深度签名**,把错误从 "damaged" 降级为可右键打开的 "unidentified developer"。
- 配了 Developer ID 时 → electron-builder 用真实身份签名(hardened runtime + `build/entitlements.mac.plist`),`build/notarize.cjs` 在有 Apple 凭据时自动公证。

ad-hoc 包仍会弹一次 Gatekeeper(右键打开/xattr 可过)。**要彻底无提示,必须走下面的正式签名 + 公证。**

---

## 正式签名 + 公证(推荐,需 Apple Developer 账号 $99/年)

1. 安装公证依赖:
   ```bash
   pnpm add -D @electron/notarize
   ```
2. 在 钥匙串 里装好 **Developer ID Application** 证书(或用 CSC_LINK 指向 .p12)。
3. 设环境变量后打包:
   ```bash
   export CSC_LINK=/path/to/DeveloperID.p12        # 或证书已在钥匙串则可省略
   export CSC_KEY_PASSWORD=********
   export APPLE_ID=you@example.com
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx   # appleid.apple.com 生成
   export APPLE_TEAM_ID=ABCDE12345
   pnpm electron:build
   ```
   electron-builder 会签名 + hardened runtime;`build/notarize.cjs` 检测到 `APPLE_*` 三个变量就提交 notarytool 公证。公证通过后 electron-builder 自动 staple。
4. 把生成的 `.dmg` 发给别人 → 双击直接装,**不再报 damaged / unidentified**。

> 没设 `APPLE_*` 时公证会自动跳过(打印 skipped),不影响 dev / ad-hoc 打包。

---

## Windows / Linux
- Windows nsis 包未签名会有 SmartScreen 提示(需 EV/OV 代码签名证书才消除)。
- Linux AppImage 无此问题。
