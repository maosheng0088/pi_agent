# PiConsole 安卓测试版

独立的 Android 原生 Java + 系统 WebView 客户端，连接 `https://ai.junweirpa.asia/`。不复制服务端、不在手机运行业务脚本、不包含员工密码或模型密钥。支持 Android 8.0（API 26）及以上，系统 WebView / Chrome 至少 120；原有网页版随服务器更新。

## 当前功能

- 原账号登录；使用 App 私有 Cookie 存储维持会话，退出或服务端过期后按原登录规则重新登录。
- 智能体、协作聊天、任务结果及管理功能沿用现有移动端网页。
- Android 系统选择器上传图片和文件，支持多选（最多 10 个），无需全盘存储或相机权限。
- 下载使用系统“另存为”选择位置，携带当前登录 Cookie，逐次检查重定向目标，只允许公司 HTTPS 同源下载；流式保存上限 100 MiB，异常时尝试删除未完成文件。
- 适配状态栏、导航区域和软键盘 Insets；页面加载进度、断网/证书异常重试界面；同源弹出链接在客户端打开，外部链接经用户点击在系统应用打开。
- 返回键优先返回网页历史；处于首页时连按两次退出。关闭 App 不影响服务器业务任务。

此版没有消息推送、语音/相机实时采集、原生自动更新；不承诺离线业务查询。`blob:` 下载暂不接入原生文件保存，使用工作台的服务器文件链接下载。不要卸载旧版后再升级；未来使用相同签名和更高 versionCode 的 APK 覆盖安装。

## 构建

无需 Android Studio / Gradle。使用官方 Android SDK Build Tools 35、Android 35 ext15，以及 Azul Zulu JDK 17。工具保存在项目 `.tools/android`；不改系统 Java 或 Android 环境。下载脚本按官方包元数据验证校验和。

```powershell
node android/scripts/inspect-toolchain.mjs
python android/scripts/select-sdk.py
node android/scripts/fallback-jdk.mjs
node android/scripts/download-toolchain.mjs --sdk-only
# 上述命令全部成功后再解压：
& ./android/scripts/extract-toolchain.ps1
node android/scripts/build.mjs
```

输出：`android/release/PiConsole-Android-0.1.0.apk`、SHA-256 文件、`release.json`。构建先编译原生源码并运行纯 Java 策略/下载测试，再进行 DEX 编译、资源打包、zipalign、APK v2/v3 签名与验签。

签名密钥与随机密码首次在 `.data/android-signing/` 生成并保留，受根目录 `.gitignore` 排除，绝不复制到公开目录或 APK。**后续升级必须保留此密钥，并把它纳入私有备份。** 不要重新生成签名替换已安装客户端。

发布：

```powershell
node android/scripts/publish.mjs
```

复制安装包、校验文件及二维码至 `public/android/`，生成 `install.html`。相同版本号存在不同字节时拒绝覆盖；原生改动先同步修改 `version.json`、Manifest 和 UA 中的版本号，再构建发布。更新不要求 Pi Web 后端重启。

## 验证与限制

已完成 Java 编译、资源/Manifest 检查、45 项策略及下载逻辑断言、签名验证、ZIP 对齐校验；安装包无调试标记，权限仅为 INTERNET。下载测试覆盖认证、同源/跨源重定向、拒绝部分内容、超限、截断、401/403、磁盘写入失败和连接释放。

本机没有安卓真机运行环境；启动、系统文件选择器、键盘和设备厂商的 WebView 行为仍需真机验收。验收时：安装并登录、重开验证会话、选图/文件发送、下载报告、弹出键盘、返回及旋转、断网重试；可先在管理员的测试智能体操作。

参考：[Android WebChromeClient 文件选择](https://developer.android.com/reference/android/webkit/WebChromeClient#onShowFileChooser(android.webkit.WebView,%20android.webkit.ValueCallback%3Candroid.net.Uri[]%3E,%20android.webkit.WebChromeClient.FileChooserParams))、[边到边与 Insets](https://developer.android.com/develop/ui/views/layout/edge-to-edge)、[AAPT2](https://developer.android.com/tools/aapt2)、[D8](https://developer.android.com/tools/d8)、[APK 签名](https://developer.android.com/tools/apksigner)。
