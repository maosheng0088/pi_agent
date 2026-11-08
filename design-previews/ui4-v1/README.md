# Pi Workspace · UI4 方向高保真预览

- 生成日期：2026-10-28
- 文件：`ui4-agent-preview.png`
- 生成方式：内置 image_gen 工具（ui-mockup）
- 性质：静态设计概念稿。聊天、姓名、任务、状态、文件、渠道绑定均为演示数据。
- 范围：预览目录独立于前端源码和构建目录；本次未部署或替换线上页面。
- 参考：用户提供的 `D:/code/pi/UI4.png` 的顶部导航、三栏布局、紧凑输入区和资料侧栏。

## 设计要点

1. 顶部统一导航：智能体、技能中心、定时任务、消息渠道、团队。
2. 左侧列表每项采用头像、名称、消息预览、时间，选中项使用浅蓝底和蓝色边条。
3. 中间主要空间留给聊天：区分发言人、时间、消息方向；文件作为紧凑附件呈现。
4. 底部单行输入区；操作围绕输入、附件、技能和发送。
5. 右侧用紧凑分区呈现协作成员、专业技能、业务任务、关联渠道和关注事项。
6. 白色连续工作面、细分隔线与克制的蓝色重点；阴影用于外层窗口。

## 落地时需要校准

- 以真实账户、权限和数据决定导航与侧栏内容，禁止把示例状态或任务数字硬编码到产品中。
- 头像、图标、文字与表单需用实际前端组件实现，不能把整张图片用作应用界面。
- 按实际屏幕宽度校准三栏比例、中文字体、消息密度与溢出处理。
- 此图只覆盖桌面主界面，窄屏、空态、加载、错误和交互状态需在实现阶段补齐。

## 最终生成提示词

```text
Use case: ui-mockup.
Asset: one finished, extremely polished high-fidelity desktop web application UI concept image for a Chinese enterprise AI collaboration product called "Pi Workspace". This is a design-review preview using invented demonstration data, not a screenshot of a live service. Make it look ready to ship, at the refinement level of an excellent professional omnichannel customer-service inbox. Compose a straight-on, perfectly flat 16:10 wide desktop view, approximately 2048x1280. No perspective distortion.

OVERALL COMPOSITION AND ART DIRECTION:
An elegant white application window occupies almost the entire canvas, with a narrow pale cool-gray outer margin (#F1F4F8), a subtle soft exterior window shadow, and 18px outer corner radii. No huge blue wallpaper. No browser address bar, fake macOS controls, device, marketing title, floating 3D illustration, or decorative dashboard. The app has a full-width 68px TOP PRODUCT NAVIGATION and THREE columns below: left inbox about 285px, generous central conversation about 760px, right useful business context about 300px at a logical viewport of 1440px. Thin pale-gray separators. White surfaces, very light cool-gray incoming bubbles, vivid but refined blue #087DF4 for sent bubbles, selected navigation and primary buttons. Dark near-black #182231 typography, clear medium-gray supporting text. Use meticulous alignments and a rhythm of 8/12/16/24px spacing. Chinese typography like Noto Sans SC and Latin like Inter: 20px product identity, 17px panel headers, 14px comfortably readable message text, 12px metadata. The content is rich and businesslike, not sparse and not crowded. Interior sections are flat rows, not a pile of outlined rounded cards. Shadows only on the app window and perhaps one subtle raised attachment; no glassmorphism, neon, gradients or cute robot.

TOP PRODUCT NAVIGATION:
At far left a beautiful small blue custom geometric pi-symbol logo and "Pi Workspace". Then horizontal Chinese menu labels exactly: "智能体", "技能中心", "定时任务", "消息渠道", "团队". "智能体" is active with pale-blue background and blue text. Far right a small neutral search icon and a fictional human account headshot with a dropdown chevron. Keep this header clean with generous horizontal breathing room; do not add a vertical icon navigation rail.

LEFT INBOX:
Header "智能体" and a compact blue plus button. Search field "搜索智能体". Two compact filter tabs "全部" and "处理中". Eight distinct agent rows, each with an intentionally designed small flat duotone professional emblem, name, a natural truncated recent-message preview and a quiet right-aligned timestamp. No unread badges or fake green online dots. Each row only name plus preview, no repeated "AI协作" or message-count line.
Rows in this order:
"提柜业务助手" selected, preview "已整理今日提柜任务，3 项需要跟进", time "09:18".
"报价助手", preview "上海至洛杉矶报价已更新", time "09:05".
"航线与 ETA", preview "本周到港计划已汇总", time "08:52".
"财务对账", preview "本月费用明细已整理", time "08:40".
"应收跟进", preview "今日待跟进清单已生成", time "昨天".
"报关单证", preview "单证资料检查完成", time "昨天".
"数据分析", preview "周度业务报告已就绪", time "昨天".
"团队助手", preview "本周协作事项已整理", time "周一".
Emblems correspond to a shipping container, quotation tag, route, finance ledger, payment, documents, chart and team respectively, all from the same restrained high-quality flat icon family. Selected row uses very light gray-blue fill and a subtle slim blue selection edge, not a saturated block. Bottom of this column a compact company/workspace switcher reading "公司共享空间".

CENTER CONVERSATION:
Slim header title "提柜业务助手" with small quiet "AI" badge, and secondary "4 位协作成员". At right unobtrusive history-search and member icons, and a compact outlined "查看任务" button. No oversized repeated avatar hero.
Small centered date divider "今天". Show an actual-looking useful work conversation with message groups, author names and timestamps:
1. RIGHT, author "你", time "09:12", blue bubble with white text exactly "帮我汇总今天需要跟进的提柜任务。". Small fictional user headshot at the right.
2. LEFT, author "提柜业务助手", time "09:13", the container agent emblem at left, a light-gray bubble with dark readable text: "已整理 18 项任务，其中 3 项需要优先跟进。". Below the sentence within the same message a restrained inline summary with two small meaningful semantic labels "已完成 15" in muted green and "待跟进 3" in muted amber. No giant result dashboard.
3. LEFT, author "运营同事", time "09:15", a small natural fictional East Asian professional headshot, gray bubble: "请把待跟进事项标清负责人，方便晚班接手。".
4. RIGHT, author "你", time "09:16", blue bubble: "好的，再把这 3 项的明细发到这里。".
5. LEFT, author "提柜业务助手", time "09:18", gray bubble: "明细已整理，负责人和下一步事项已标注。". Under it one beautifully composed compact file attachment, a green XLSX document icon, "提柜任务汇总.xlsx", smaller "24 KB", and a small download icon. This is a mockup attachment.
Keep the conversation asymmetrical and natural with varied bubble widths and measured gaps. Sender names and timestamps have clear hierarchy; never repeat large AI badges. Make all important Chinese text crisp and accurate.
At the very bottom a SINGLE compact 54px message composer line, not a large textarea panel: small paperclip, placeholder "输入任务或消息…", a subtle skill menu icon, and a strong blue "发送" button with a paper-plane icon. The composer spans the central column without a second toolbar or a large footnote strip. Conversation gets most of the vertical space.

RIGHT BUSINESS CONTEXT:
A useful compact professional panel, not a giant profile repeated from the header. At top a small 36px container emblem alongside title "提柜业务助手"; below a short description "提柜进度 · 异常跟进 · 协作交接". This identity block must be compact, about 90px high, not more than a fifth of the sidebar.
Then clean horizontal dividers and flat information sections with 14px semibold titles:
"协作成员" with count "4", a small invite-plus action and four small fictional natural headshots in a row, with short quiet role labels.
"专业技能" with count "2", two neat icon-and-text rows "飞书多维表格" and "提柜信息同步". Use tasteful file/integration icons with different but restrained colors, no large bordered cards.
"业务任务", two compact rows: "今日提柜任务汇总" with green "已完成"; "异常事项复核" with amber "待跟进". Small task icons and subtle chevrons.
"关联渠道", a green business-chat mark and "企业微信", smaller "已绑定业务群".
"关注事项", one quiet amber-accent line "3 项待跟进", and supporting text "交接前确认负责人和处理时限".
The sidebar should feel informative, organized and balanced, with useful real-looking content at every level. Do not add phone numbers, billing, charts, huge profile cover art, decorative counters, fake photos of documents, giant cards or slogans.

IMPORTANT:
All people and data are invented for this preview. Add a small discreet caption in the OUTER bottom margin exactly "界面概念稿 · 演示数据". Do not make it look like a published production screenshot. No other watermark. Do not use any Omnix brand name. Preserve the disciplined top-nav, three-column inbox composition; this must feel like a refined enterprise messaging workspace with specialized AI agents, not an admin dashboard skin.
```

