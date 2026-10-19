# SITE-01 integration status

The exact current SDK source-resolvers.ts contract is now connected. activate registers {id:'bilibili',schemes:['http','https'],hosts:['bilibili.com','www.bilibili.com','m.bilibili.com','b23.tv']} and an async handler accepting {url,signal}. The handler validates URL paths through extractBilibili, preserves originalUrl/title, maps media to primary and preserves separate audio and each resource's headers. Resolver lease disposal aborts active work. Manifest includes the implemented source.resolve capability.

The UI submits original page URLs through the public source.submit path with stable IDs, recovers uncertain RPC results by querying source.operation with the same ID, and polls backend source state before reporting readiness. Cancellation uses a stamp-scoped close. No private RPC or dependency on other site plugins is present. Arbitrary public source callers receive the same routing.

No remaining API request blocks this plugin. The shared host intentionally rejects distinct primary/audio header maps because the current mpv backend can apply one common map; this plugin preserves both maps for that validation. Shared generic API checks do not substitute for an actual Bilibili media playback check, which is delegated to the maintainer with exclusive host/GUI/audio access.
