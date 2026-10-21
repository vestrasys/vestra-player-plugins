# YouTube

在 Vestra Player 里播放或下载单个公开 YouTube 视频。

## 使用

右键菜单 **打开 → YouTube 视频…**，粘贴链接：

- 按 Enter 或「播放」直接播放；
- 「下载视频…」选择保存位置，下载为 `.mkv` 文件。

在播放列表或「打开」里直接输入 YouTube 链接也能播放。支持 watch、shorts、live、embed 和 youtu.be 链接；链接里的播放列表参数会被忽略。

## 需要

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) `2026.08.19`，在 PATH 上（或用环境变量 `VESTRA_YT_DLP` 指定）；
- 下载需要 [ffmpeg](https://ffmpeg.org/)，在 PATH 上。

插件不会自动安装或更新这两个程序。

## 限制

- 不支持登录、会员、付费、地区限制和 DRM 视频，也不读取浏览器 cookie；这些情况会显示 yt-dlp 给出的原因。
- 不支持整个播放列表。
