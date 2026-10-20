# YouTube（youtube）

功能：播放或下载单个公开 YouTube 视频（watch、shorts、live、embed、youtu.be 的 HTTPS 链接；`list` 参数被忽略，纯播放列表链接不支持）。插件注册公共来源解析器（`youtube.com`、`www.youtube.com`、`m.youtube.com`、`music.youtube.com`、`youtu.be`），任何调用方打开这些链接都由它用 yt-dlp 解析，保留分离的视频/音频与各自的请求头。

入口：`文件 → 网络媒体 → YouTube 视频…` 打开独立窗口（`youtube.slint`）：粘贴链接后“播放”（以公开来源状态确认就绪，最长等待 120 秒）或“下载视频…”（原生保存对话框，只接受 `.mkv`）；“取消”中止解析/载入（关闭本插件打开的媒体）或下载。

下载：yt-dlp 下载音视频并由 ffmpeg 合并为 MKV，写入目标旁的私有临时目录，只有完整非空文件才改名到目标位置；失败或取消时清理临时目录，不改动已有目标文件。显示下载百分比与合并阶段。插件停用时终止正在运行的 yt-dlp 进程组。

依赖与限制：
- 需要 yt-dlp `2026.08.19`（运行前校验版本；`VESTRA_YT_DLP` 可指定可执行文件，默认 PATH 上的 `yt-dlp`），下载另需 PATH 上的 ffmpeg。版本、来源与许可证记录在 `dependencies.lock.json`；插件不安装、不更新、不捆绑可执行文件。
- 不使用 shell、cookies、浏览器配置或用户 yt-dlp 配置；登录、地区、付费、DRM 等错误如实显示。
- 共享后端要求分离的视频/音频使用相同的请求头；不同时由宿主明确报错。

开发（在 `src/` 下）：`npm run plugin -- check youtube`、`build youtube`、`test youtube`。测试不联网、不调用真实 yt-dlp。
