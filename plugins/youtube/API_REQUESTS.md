# SITE-01 integration status (2026-10-19)

Shared maintainer implemented the public SDK in source-resolvers.ts. This package now registers sourceResolvers.register({id:'youtube',schemes:['https'],hosts:[exact supported hosts]}, handler), returns a generic media descriptor with originalUrl/title/video/audio/headers, and disposes the lease on unload. Host cancellation propagates through the SDK AbortSignal into yt-dlp. Register failures unwind activation; command registration failures dispose the resolver.

Play uses source.submit({kind:'open',source:originalURL,startPaused:false}, operationId). It queries source.operation by the same ID after uncertain submission, polls source.state and operation until ready/error/replacement, and never blindly resubmits. Cancel closes with the returned ticket's expected stamp so it cannot close a newer source. Native playback success is only displayed after the matching source reports ready. Transport failures and unknown outcomes remain explicit errors.

Any caller can submit a supported original URL through the same host resolver. This package reads/calls no playlist implementation or private plugin channel. Host keeps original URL as public source identity; extracted resource headers remain in the private descriptor.

The shared backend currently requires identical header maps for separate video and audio resources. We retain both maps as extracted; differing maps must be rejected by the host rather than losing audio. No site-specific logic was added to Rust.

Still required: maintainer native activation/Slint checks and real libmpv source playback with both tracks. Logic tests and prior real extraction/download do not establish successful native playback. Site authentication/bot errors must remain errors; no browser cookies or private data access is used.

Canonical reviewed menu path: 文件 → 网络媒体 → YouTube 视频… (title matches leaf).
