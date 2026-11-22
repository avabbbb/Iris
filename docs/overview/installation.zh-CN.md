# Iris 安装与使用指引

本指引面向**不熟悉电脑操作**的使用者。使用 Windows 安装包时不需要安装
Node.js、Rust 或打开命令行。
当前候选安装包文件名：`Iris_0.1.0_x64-setup.exe`（大小以发布页为准）。

---

## 一、安装前准备

- 一台 Windows 10 或 Windows 11 的电脑（64 位）。
- 如果要生成图片或视频，再准备一个 AI 服务的 API Key；第一次打开不要求立即配置。
- 不需要 Node.js、Rust 或其它开发工具。

## 二、安装步骤（约 2 分钟）

1. 双击安装包 `Iris_0.1.0_x64-setup.exe`。
2. 如果弹出蓝色「Windows 已保护你的电脑」窗口——**这是正常的**（软件还没购买微软的数字签名证书），请按下面操作放行：
   - 先确认文件来自 Iris 官方 GitHub Releases 页面，并核对发布页提供的 SHA-256 与下载文件一致（PowerShell：Get-FileHash 文件名 -Algorithm SHA256）。
   - 核对一致后，点击「更多信息」→「仍要运行」。0.1.0 内测版尚未配置 Windows 代码签名，这一提示是预期行为；SHA-256 不一致或来源不明时不要运行。
3. 语言选择「简体中文」（默认即是）。
4. 一路点击「下一步 / 安装」，不需要改任何选项，不会要求输入管理员密码。
5. 安装完成后，桌面会出现 **Iris** 图标，双击即可打开。

## 三、第一次使用（配置 AI 服务）

1. 首次打开可以直接进入 Canvas；没有 AI 服务时仍然可以浏览、编辑和搭建工作流。
2. 需要生成时点击「添加 AI 服务」。
3. 对 OpenAI-compatible 服务填写服务地址和 API Key；只有服务没有自动返回模型时，才手动填写模型名。
4. 点击「连接」后，Iris 会尝试发现模型；连接失败时按页面提示检查地址或凭据并重试。
5. 生成图片或视频前会显示 AI 服务、模型和执行确认；确认后才提交外部生成请求。

## 四、日常使用与更新

- 正式发布包接入更新源后，打开软件可检查更新；更新包必须通过签名校验。
- 本地构建包默认不生成正式更新产物，不能把本地测试包当作自动更新验收。

## 五、常见问题

| 问题 | 解决办法 |
| --- | --- |
| 双击后被 SmartScreen / 杀毒软件拦截 | 先核对下载来源与 SHA-256；一致时点击「更多信息 → 仍要运行」。不一致或来源不明请删除文件，并提交内测反馈 Issue |
| 打开后闪退 | 确认系统是 Windows 10/11 64 位；重启电脑后再试 |
| 忘记或更换 API Key | 在主界面进入「设置」，重新填写并验证即可 |
| 想卸载 | Windows「设置 → 应用 → 已安装的应用 → Iris → 卸载」 |

---

## 六、给分发者的说明

- 本地构建产物：`src-tauri/target/release/bundle/nsis/Iris_0.1.0_x64-setup.exe`；本地构建使用 `src-tauri/tauri.local.conf.json`，不生成正式更新签名。
- 正式发布流程：由维护者在确认 Hosted release gate、生产签名和产物校验通过后，再按 `.github/workflows/build-desktop.yml` 发布；未完成这些外部门禁前，不应宣称 `latest.json` 或自动更新已经可用。
- 安装器采用「当前用户」模式（`installMode: currentUser`）：无需管理员权限、不弹 UAC、卸载干净，最适合分发给普通用户。
- 若要消除 SmartScreen 首次拦截，需要代码签名证书（OV 证书或 Azure Trusted Signing），在 `src-tauri/tauri.conf.json → bundle.windows.certificateThumbprint` 填入指纹后重新出包。
